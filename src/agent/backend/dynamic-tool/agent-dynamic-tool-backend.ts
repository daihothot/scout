import type {
  DynamicToolCallInput,
  DynamicToolCallResponse,
} from "../../../agent-server/types.js";
import type { ScoutAgent } from "../../core/scout-agent.js";
import { CoordinatorAgent } from "../../roles/coordinator-agent.js";
import {
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
} from "../../tools/agent-tools.js";
import { AgentTaskBackend } from "./agent-task-backend.js";
import { AgentHumanInputBackend } from "./agent-human-input-backend.js";
import { WorkerAgent } from "../../roles/worker-agent.js";
import { attachments } from "../../context/attachments.js";
import { agent } from "../../context/agent-attachments.js";
import { currentRunScope, type RunScope } from "../../../run/run-scope.js";

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
  private readonly domains: RunScope["domainRegistry"];
  private readonly taskStore: RunScope["taskStore"];
  private readonly taskBackend: AgentTaskBackend;
  private unsubscribeDynamicTools?: () => void;
  private readonly phaseOutcomeReceipts = new WeakMap<CoordinatorAgent, {
    threadId: string;
    turnId: string;
    callId: string;
    outcome: SubmitPhaseOutcomeToolCall["outcome"];
    response: Record<string, unknown>;
  }>();

  constructor() {
    const scope = currentRunScope();
    this.registry = scope.agentRegistry;
    this.domains = scope.domainRegistry;
    this.taskStore = scope.taskStore;
    const humanInputBackend = new AgentHumanInputBackend();
    this.taskBackend = new AgentTaskBackend({ humanInputBackend });
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
    try {
      const phase = currentRunScope().workflow.scheduler.current().name;
      const call = {
        input,
        caller: {
          agentId: caller.agentId,
          role: caller.role,
          phase,
          threadId: caller.threadId,
        },
      } satisfies import("../../../domain/types.js").ScoutDomainDynamicToolCall;
      const assigned = currentRunScope().workflow.scheduler.snapshot().roles.some((role) =>
        role.name === caller.role && role.phases.includes(phase)
      );
      if (!assigned) {
        return dynamicToolFailure(
          `Role ${caller.role} is not assigned to the current Workflow Phase ${phase}.`,
        );
      }
      const owners = this.domains.list().filter((domain) =>
        domain.backend.dynamicToolsForPhase(phase).some((tool) =>
          (tool.namespace ?? null) === input.namespace && tool.name === input.tool
        )
      );
      if (owners.length === 0) {
        return dynamicToolFailure(
          `Unsupported dynamic tool namespace: ${input.namespace ?? "null"}`,
        );
      }
      if (owners.length > 1) {
        throw new Error(
          `Dynamic tool ${input.namespace ?? "<none>"}/${input.tool}`
          + ` is registered by multiple Scout Domains: ${owners.map((domain) =>
            domain.description.id
          ).join(", ")}.`,
        );
      }
      const owner = owners[0]!;
      return await owner.backend.handleDynamicToolCall(call) ?? dynamicToolFailure(
        `Unsupported dynamic tool namespace: ${input.namespace ?? "null"}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      return dynamicToolFailure(message);
    }
  }

  private async handleAssignTaskToolCall(
    call: AssignTaskToolCall,
  ): Promise<AssignTaskToolResponse> {
    if (currentRunScope().workflow.flowSnapshot().status !== "active") {
      throw new Error("Cannot assign a new Task while the Workflow Flow is settling or completed.");
    }
    const phase = currentRunScope().workflow.scheduler.current();
    const workerRole = phase.selectAvailableRole((role) => {
      const candidate = this.registry.findAgent(role);
      return candidate instanceof WorkerAgent && candidate.canAcceptTask();
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
      prompt: attachments.compose(
        agent.turn.workflow_phase(),
        agent.turn.message(call.prompt),
      ),
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
    caller: ScoutAgent,
    delivery: DynamicToolCallInput,
  ): Record<string, unknown> {
    if (!(caller instanceof CoordinatorAgent)) {
      throw new Error("SubmitPhaseOutcome is only available to the Coordinator agent.");
    }
    caller.assertOwnsActiveTurn(delivery);
    const receipt = this.phaseOutcomeReceipts.get(caller);
    if (receipt?.threadId === delivery.threadId && receipt.turnId === delivery.turnId) {
      if (receipt.callId === delivery.callId && receipt.outcome === call.outcome) {
        return structuredClone(receipt.response);
      }
      throw new Error("This Coordinator turn already submitted a Phase outcome; continue in the next Phase's turn.");
    }
    const advanced = currentRunScope().workflow.scheduler.advance(call.outcome);
    const response = {
      status: "accepted",
      currentPhase: advanced.state.currentPhase,
      cycleCompleted: advanced.cycleCompleted,
    };
    this.phaseOutcomeReceipts.set(caller, { threadId: delivery.threadId, turnId: delivery.turnId, callId: delivery.callId, outcome: call.outcome, response });
    if (!advanced.cycleCompleted) caller.scheduleCurrentPhaseStep();
    else caller.scheduleFlowSettlementStep();
    return structuredClone(response);
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
      case "SubmitPhaseOutcome":
        return this.handleSubmitPhaseOutcomeToolCall(call, caller, delivery);
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
