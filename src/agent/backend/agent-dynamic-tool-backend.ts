import type {
  DynamicToolCallInput,
  DynamicToolCallResponse,
} from "../../agent-server/types.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import { CoordinatorAgent } from "../roles/coordinator-agent.js";
import {
  type ArchiveTaskToolCall,
  type AssignTaskToolCall,
  AGENT_TOOL_NAMESPACES,
  assertAgentToolNamespace,
  parseAgentDynamicToolCall,
  type RequestHumanInputToolCall,
  type RespondHumanInputToolCall,
  type SendMessageToolCall,
  type SubmitTaskToolCall,
  type SubmitPhaseOutcomeToolCall,
  type AgentDynamicToolCall,
} from "../tools/agent-tools.js";
import type { AgentTaskBackend } from "./agent-task-backend.js";
import { WorkerAgent } from "../roles/worker-agent.js";
import { agent } from "../context/agent-attachments.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";

/** Dependencies required to dispatch agent-owned dynamic tools. */
export interface AgentDynamicToolBackendOptions {
  taskBackend: AgentTaskBackend;
}

type AssignTaskToolResponse =
  | {
    status: "assigned";
    taskId: string;
  }
  | {
    status: "not_assigned";
    reason: string;
  };

/**
 * Dispatches validated agent dynamic tools to task, message, and human-input
 * backends while routing other namespaces to the domain.
 */
export class AgentDynamicToolBackend {
  private readonly registry: RunScope["agentRegistry"];
  private readonly taskStore: RunScope["taskStore"];
  private readonly taskBackend: AgentTaskBackend;
  private readonly domain: RunScope["domain"];
  private readonly scheduler: RunScope["scheduler"];
  private unsubscribeDynamicTools?: () => void;

  constructor(options: AgentDynamicToolBackendOptions) {
    const scope = currentRunScope();
    this.registry = scope.agentRegistry;
    this.taskStore = scope.taskStore;
    this.taskBackend = options.taskBackend;
    this.domain = scope.domain;
    this.scheduler = scope.scheduler;
  }

  start(): void {
    if (this.unsubscribeDynamicTools) return;
    const appServer = currentRunScope().appServer;
    this.unsubscribeDynamicTools = appServer.setDynamicToolCallHandler((input) =>
      this.handleDynamicToolCall(input)
    );
  }

  stop(): void {
    const unsubscribe = this.unsubscribeDynamicTools;
    this.unsubscribeDynamicTools = undefined;
    unsubscribe?.();
  }

  async handleDynamicToolCall(input: DynamicToolCallInput): Promise<DynamicToolCallResponse> {
    const caller = this.registry.resolveToolCaller(input.threadId);
    if (!caller) {
      return dynamicToolFailure(`Unknown dynamic tool caller thread: ${input.threadId}`);
    }
    if (!input.namespace || !AGENT_TOOL_NAMESPACES.has(input.namespace)) {
      return this.handleDomainToolCall(input, caller);
    }

    try {
      assertAgentToolNamespace(input.namespace, input.tool);
      const call = parseAgentDynamicToolCall(input.tool, input.arguments);
      const result = await this.dispatchAgentDynamicToolCall(call, caller, input);
      return dynamicToolSuccess(result);
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      return dynamicToolFailure(message);
    }
  }

  private async handleDomainToolCall(
    input: DynamicToolCallInput,
    caller: ScoutAgent,
  ): Promise<DynamicToolCallResponse> {
    if (!this.domain.handleDynamicToolCall) {
      return dynamicToolFailure(`Unsupported dynamic tool namespace: ${input.namespace ?? "null"}`);
    }

    try {
      const result = await this.domain.handleDynamicToolCall({
        input,
        caller: {
          agentId: caller.agentId,
          role: caller.role,
          threadId: caller.threadId,
        },
      });
      if (!result) {
        return dynamicToolFailure(`Unsupported dynamic tool namespace: ${input.namespace ?? "null"}`);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      return dynamicToolFailure(message);
    }
  }

  private async handleAssignTaskToolCall(
    call: AssignTaskToolCall,
  ): Promise<AssignTaskToolResponse> {
    const phase = this.scheduler.current();
    const workerRole = phase.selectAvailableRole((role) => {
      const candidate = this.registry.findAgent(role);
      return candidate instanceof WorkerAgent && candidate.taskRunner === undefined;
    });
    if (!workerRole) {
      return {
        status: "not_assigned",
        reason: `Workflow Phase ${phase.name} has no available Worker.`,
      };
    }
    const worker = this.registry.resolveAgent(workerRole);
    if (!(worker instanceof WorkerAgent)) {
      throw new Error(`Workflow Phase ${phase.name} role ${workerRole} is not a Worker agent.`);
    }
    const assignment = await worker.assignTask({
      phase: phase.name,
      description: call.description,
      prompt: agent.turn.message(call.prompt),
      isBackgrounded: true,
    });
    if (!assignment.ok) {
      const rejection = assignment.error;
      return {
        status: "not_assigned",
        reason: rejection.reason,
      };
    }
    const task = assignment.value;
    return {
      status: "assigned",
      taskId: task.taskId,
    };
  }

  private handleSubmitPhaseOutcomeToolCall(
    call: SubmitPhaseOutcomeToolCall,
    caller: CoordinatorAgent,
  ): Record<string, unknown> {
    const advanced = this.scheduler.advance(call.outcome);
    if (!advanced.cycleCompleted) caller.scheduleCurrentPhaseStep();
    return {
      status: "accepted",
      currentPhase: advanced.state.currentPhase,
      cycleCompleted: advanced.cycleCompleted,
    };
  }

  private async handleArchiveTaskToolCall(
    call: ArchiveTaskToolCall,
    caller: ScoutAgent,
  ): Promise<Record<string, unknown>> {
    if (!(caller instanceof CoordinatorAgent)) {
      throw new Error("ArchiveTask is only available to the Coordinator agent.");
    }
    const archived = await this.taskBackend.archiveAgentTask(call.task_id);
    return {
      status: "archived",
      taskId: archived.taskId,
      agentId: archived.agentId,
      role: archived.role,
    };
  }

  private async handleSubmitTaskToolCall(
    call: SubmitTaskToolCall,
    caller: ScoutAgent,
    delivery: DynamicToolCallInput,
  ): Promise<Record<string, unknown>> {
    if (!(caller instanceof WorkerAgent)) {
      throw new Error("SubmitTask is only available to Worker agents.");
    }
    const submitted = await this.taskBackend.submitTask({ call, caller, delivery });
    return {
      status: "accepted",
      taskId: submitted.taskId,
      agentId: submitted.agentId,
      role: submitted.role,
    };
  }

  private async handleSendMessageToolCall(
    call: SendMessageToolCall,
  ): Promise<Record<string, unknown>> {
    const task = this.taskStore.getTask(call.to);
    const target = task
      ? this.registry.resolveAgent(task.agentId)
      : this.registry.resolveAgent(call.to);
    const result = await target.sendMessage({
      taskId: task?.taskId,
      message: agent.turn.message(call.message),
      deliveryMode: call.delivery_mode,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    return task
      ? {
        status: "queued",
        taskId: task.taskId,
        agentId: target.agentId,
      }
      : {
        status: "queued",
        agentId: target.agentId,
      };
  }

  private async handleRequestHumanInputToolCall(
    call: RequestHumanInputToolCall,
    caller: ScoutAgent,
    delivery: DynamicToolCallInput,
  ): Promise<Record<string, unknown>> {
    if (!(caller instanceof WorkerAgent)) {
      throw new Error("RequestHumanInput is only available to Worker agents.");
    }
    return this.taskBackend.requestHumanInput({ call, caller, delivery });
  }

  private async handleRespondHumanInputToolCall(
    call: RespondHumanInputToolCall,
    caller: ScoutAgent,
    delivery: DynamicToolCallInput,
  ): Promise<Record<string, unknown>> {
    if (!(caller instanceof CoordinatorAgent)) {
      throw new Error("RespondHumanInput is only available to the Coordinator agent.");
    }
    return this.taskBackend.respondHumanInput({ call, caller, delivery });
  }

  private async dispatchAgentDynamicToolCall(
    call: AgentDynamicToolCall,
    caller: ScoutAgent,
    delivery: DynamicToolCallInput,
  ): Promise<unknown> {
    switch (call.tool) {
      case "AssignTask":
        return this.handleAssignTaskToolCall(call);
      case "SendMessage":
        return this.handleSendMessageToolCall(call);
      case "RequestHumanInput":
        return this.handleRequestHumanInputToolCall(call, caller, delivery);
      case "RespondHumanInput":
        return this.handleRespondHumanInputToolCall(call, caller, delivery);
      case "SubmitTask":
        return this.handleSubmitTaskToolCall(call, caller, delivery);
      case "ArchiveTask":
        return this.handleArchiveTaskToolCall(call, caller);
      case "SubmitPhaseOutcome":
        return this.handleSubmitPhaseOutcomeToolCall(call, caller as CoordinatorAgent);
      default:
        throw new Error(`Unsupported agent tool: ${String((call as { tool?: unknown }).tool)}`);
    }
  }

}

function dynamicToolSuccess(value: unknown): DynamicToolCallResponse {
  return {
    success: true,
    contentItems: [{
      type: "inputText",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
  };
}

function dynamicToolFailure(message: string): DynamicToolCallResponse {
  return {
    success: false,
    contentItems: [{
      type: "inputText",
      text: message,
    }],
  };
}
