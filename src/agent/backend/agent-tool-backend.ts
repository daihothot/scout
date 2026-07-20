import type {
  DynamicToolCallInput,
  DynamicToolCallResponse,
} from "../../agent-server/types.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import { ScoutAgentRoles } from "../thread/types.js";
import {
  type ArchiveTaskToolCall,
  type AssignTaskToolCall,
  AGENT_TOOL_NAMESPACES,
  parseAgentDynamicToolCall,
  type RequestHumanInputToolCall,
  type RespondHumanInputToolCall,
  type SendMessageToolCall,
  type SubmitTaskToolCall,
  type AgentDynamicToolCall,
} from "../tools/agent-tools.js";
import type { AgentTaskBackend } from "./agent-task-backend.js";
import type { AgentProvider } from "./types.js";
import { AgentTaskStatuses, type AgentTaskState } from "../task/types.js";
import { WorkerAgent } from "../roles/worker-agent.js";
import { agent } from "../context/agent-attachments.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";

export interface AgentToolBackendOptions {
  taskBackend: AgentTaskBackend;
  agentProvider: AgentProvider;
}

type AssignTaskToolResponse =
  | {
    status: "assigned";
    taskId: string;
    agentId: string;
    role: AgentTaskState["role"];
    description: string;
  }
  | {
    status: "not_assigned";
    agentId: string;
    role: AgentTaskState["role"];
    activeTaskId: string;
    reason: string;
  };

export class AgentToolBackend {
  private readonly registry: RunScope["agentRegistry"];
  private readonly taskStore: RunScope["taskStore"];
  private readonly taskBackend: AgentTaskBackend;
  private readonly agentProvider: AgentProvider;
  private readonly domain: RunScope["domain"];

  constructor(options: AgentToolBackendOptions) {
    const scope = currentRunScope();
    this.registry = scope.agentRegistry;
    this.taskStore = scope.taskStore;
    this.taskBackend = options.taskBackend;
    this.agentProvider = options.agentProvider;
    this.domain = scope.domain;
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
      const call = parseAgentDynamicToolCall(input.tool, input.arguments);
      const result = await this.dispatchAgentDynamicToolCall(call, caller);
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

  private handleAssignTaskToolCall(
    call: AssignTaskToolCall,
  ): AssignTaskToolResponse {
    const worker = this.resolveAssignableWorker(call);
    const assignment = worker.assignTask({
      agentId: worker.agentId,
      description: call.description,
      subagentType: call.subagent_type,
      prompt: agent.turn.message(call.prompt),
      isBackgrounded: true,
    });
    if (!assignment.ok) {
      const rejection = assignment.error;
      return {
        status: "not_assigned",
        agentId: rejection.agentId,
        role: rejection.role,
        activeTaskId: rejection.activeTaskId,
        reason: rejection.reason,
      };
    }
    const task = assignment.value;
    return {
      status: "assigned",
      taskId: task.taskId,
      agentId: task.agentId,
      role: task.role,
      description: task.description,
    };
  }

  private async handleArchiveTaskToolCall(
    call: ArchiveTaskToolCall,
    caller: ScoutAgent,
  ): Promise<Record<string, unknown>> {
    if (caller.role !== ScoutAgentRoles.Coordinator) {
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

  private handleSubmitTaskToolCall(
    call: SubmitTaskToolCall,
    caller: ScoutAgent,
  ): Record<string, unknown> {
    if (!(caller instanceof WorkerAgent)) {
      throw new Error("SubmitTask is only available to Worker agents.");
    }
    const submitted = caller.submitTask(call.outcome);
    if (!submitted.ok) throw new Error(submitted.error);
    return {
      status: "accepted",
      taskId: submitted.value.taskId,
      agentId: submitted.value.agentId,
      role: submitted.value.role,
    };
  }

  private handleSendMessageToolCall(
    call: SendMessageToolCall,
  ): Record<string, unknown> {
    const task = this.taskStore.getTask(call.to);
    const target = task
      ? this.registry.resolveAgent(task.agentId)
      : this.registry.resolveAgent(call.to);
    const result = target.sendMessage({
      taskId: task?.taskId,
      message: agent.turn.message(call.message),
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

  private handleRequestHumanInputToolCall(
    call: RequestHumanInputToolCall,
    caller: ScoutAgent,
  ): Record<string, unknown> {
    if (!(caller instanceof WorkerAgent)) {
      throw new Error("RequestHumanInput is only available to Worker agents.");
    }
    const task = caller.snapshot().activeTask;
    if (!task || task.status !== AgentTaskStatuses.Running) {
      throw new Error(`Worker agent ${caller.agentId} has no running task for RequestHumanInput.`);
    }
    const coordinator = this.registry.listAgents().find((candidate) =>
      candidate.role === ScoutAgentRoles.Coordinator
    );
    if (!coordinator) {
      throw new Error(`Worker agent ${caller.agentId} cannot find the Coordinator agent.`);
    }
    const result = coordinator.sendMessage({
      message: agent.turn.wait_for_human_request(call.request),
    });
    if (!result.ok) throw new Error(result.error);
    return {
      status: "queued",
      taskId: task.taskId,
      agentId: coordinator.agentId,
    };
  }

  private handleRespondHumanInputToolCall(
    call: RespondHumanInputToolCall,
    caller: ScoutAgent,
  ): Record<string, unknown> {
    if (caller.role !== ScoutAgentRoles.Coordinator) {
      throw new Error("RespondHumanInput is only available to the Coordinator agent.");
    }
    const task = this.taskStore.getTask(call.task_id);
    if (!task) throw new Error(`Unknown agent task: ${call.task_id}`);
    const target = this.registry.resolveAgent(task.agentId);
    const result = target.sendMessage({
      taskId: task.taskId,
      message: agent.turn.human_response(call.response),
    });
    if (!result.ok) throw new Error(result.error);
    return {
      status: "queued",
      taskId: task.taskId,
      agentId: target.agentId,
    };
  }

  private async dispatchAgentDynamicToolCall(
    call: AgentDynamicToolCall,
    caller: ScoutAgent,
  ): Promise<Record<string, unknown>> {
    switch (call.tool) {
      case "AssignTask":
        return this.handleAssignTaskToolCall(call);
      case "SendMessage":
        return this.handleSendMessageToolCall(call);
      case "RequestHumanInput":
        return this.handleRequestHumanInputToolCall(call, caller);
      case "RespondHumanInput":
        return this.handleRespondHumanInputToolCall(call, caller);
      case "SubmitTask":
        return this.handleSubmitTaskToolCall(call, caller);
      case "ArchiveTask":
        return this.handleArchiveTaskToolCall(call, caller);
      default:
        throw new Error(`Unsupported agent tool: ${String((call as { tool?: unknown }).tool)}`);
    }
  }

  private resolveAssignableWorker(call: AssignTaskToolCall): WorkerAgent {
    const worker = call.agent_id
      ? this.registry.resolveAgent(call.agent_id) as WorkerAgent
      : this.agentProvider.resolveWorker({
        role: call.subagent_type,
      });
    if (worker.role !== call.subagent_type) {
      throw new Error(`Agent ${worker.agentId} is ${worker.role}, not ${call.subagent_type}.`);
    }
    return worker;
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
