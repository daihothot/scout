import { randomUUID } from "node:crypto";
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
  assertAgentToolNamespace,
  parseAgentDynamicToolCall,
  type RequestHumanInputToolCall,
  type RespondHumanInputToolCall,
  type SendMessageToolCall,
  type SubmitTaskToolCall,
  type AgentDynamicToolCall,
} from "../tools/agent-tools.js";
import type { AgentTaskBackend } from "./agent-task-backend.js";
import { AgentTaskStatuses, type AgentTaskState } from "../task/types.js";
import { WorkerAgent } from "../roles/worker-agent.js";
import { agent } from "../context/agent-attachments.js";
import { attachments } from "../context/attachments.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import { AgentEvents } from "../events/index.js";

/** Dependencies required to dispatch agent-owned dynamic tools. */
export interface AgentToolBackendOptions {
  taskBackend: AgentTaskBackend;
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

/**
 * Dispatches validated agent dynamic tools to task, message, and human-input
 * backends while routing other namespaces to the domain.
 */
export class AgentToolBackend {
  private readonly registry: RunScope["agentRegistry"];
  private readonly taskStore: RunScope["taskStore"];
  private readonly taskBackend: AgentTaskBackend;
  private readonly domain: RunScope["domain"];
  private readonly humanInputStore: RunScope["humanInputStore"];
  private readonly eventBus: RunScope["eventBus"];

  constructor(options: AgentToolBackendOptions) {
    const scope = currentRunScope();
    this.registry = scope.agentRegistry;
    this.taskStore = scope.taskStore;
    this.taskBackend = options.taskBackend;
    this.domain = scope.domain;
    this.humanInputStore = scope.humanInputStore;
    this.eventBus = scope.eventBus;
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
    const worker = this.resolveAssignableWorker(call);
    const assignment = await worker.assignTask({
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

  private async handleSubmitTaskToolCall(
    call: SubmitTaskToolCall,
    caller: ScoutAgent,
    delivery: DynamicToolCallInput,
  ): Promise<Record<string, unknown>> {
    if (!(caller instanceof WorkerAgent)) {
      throw new Error("SubmitTask is only available to Worker agents.");
    }
    const task = caller.snapshot().activeTask;
    if (!task) {
      throw new Error(`Worker agent ${caller.agentId} has no active task to submit.`);
    }
    const unresolvedRequest = this.humanInputStore.listForTask(task.taskId).find((request) =>
      request.taskId === task.taskId && !request.response
    );
    if (unresolvedRequest) {
      throw new Error(
        `Worker task ${task.taskId} cannot be submitted while human request ${unresolvedRequest.requestId} is unresolved.`,
      );
    }
    caller.assertOwnsActiveTurn({
      threadId: delivery.threadId,
      turnId: delivery.turnId,
    });
    const submitted = await caller.submitTask({
      outcome: call.outcome,
      turnId: delivery.turnId,
      callId: delivery.callId,
    });
    if (!submitted.ok) throw new Error(submitted.error);
    return {
      status: "accepted",
      taskId: submitted.value.taskId,
      agentId: submitted.value.agentId,
      role: submitted.value.role,
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
    const task = caller.snapshot().activeTask;
    if (!task || task.status !== AgentTaskStatuses.Running) {
      throw new Error(`Worker agent ${caller.agentId} has no running task for RequestHumanInput.`);
    }
    caller.assertOwnsActiveTurn({
      threadId: delivery.threadId,
      turnId: delivery.turnId,
    });
    const lifecycleCall = {
      turnId: delivery.turnId,
      callId: delivery.callId,
      request: call.request,
    };
    const begun = caller.beginHumanInput(lifecycleCall);
    if (!begun.ok) throw new Error(begun.error);
    const recordedDisposition = begun.value.steps?.at(-1)?.disposition;
    try {
      if (recordedDisposition?.kind === "waiting_for_human") {
        const recordedRequest = this.humanInputStore.listForTask(task.taskId).find((request) =>
          request.requestId === recordedDisposition.requestId
        );
        if (!recordedRequest) {
          throw new Error(
            `Worker task ${task.taskId} is missing recorded human request ${recordedDisposition.requestId}.`,
          );
        }
        const coordinator = this.registry.listAgents().find((candidate) =>
          candidate.role === ScoutAgentRoles.Coordinator
        );
        if (!coordinator) {
          throw new Error(`Worker agent ${caller.agentId} cannot find the Coordinator agent.`);
        }
        if (!recordedRequest.response) {
          const redelivered = await coordinator.sendMessage({
            message: recordedRequest.message.body,
            delivery: {
              messageId: recordedRequest.message.messageId,
              queuedAt: recordedRequest.message.queuedAt,
            },
          });
          if (!redelivered.ok) throw new Error(redelivered.error);
        }
        return {
          status: recordedRequest.response ? "accepted" : "queued",
          taskId: task.taskId,
          agentId: coordinator.agentId,
          requestId: recordedRequest.requestId,
        };
      }

      const coordinator = this.registry.listAgents().find((candidate) =>
        candidate.role === ScoutAgentRoles.Coordinator
      );
      if (!coordinator) {
        throw new Error(`Worker agent ${caller.agentId} cannot find the Coordinator agent.`);
      }
      const existing = this.humanInputStore.listForTask(task.taskId).find((request) =>
        request.taskId === task.taskId && !request.response
      );
      if (existing) {
        if (existing.body !== call.request) {
          throw new Error(`Worker task ${task.taskId} already has unresolved human request ${existing.requestId}.`);
        }
        const result = await coordinator.sendMessage({
          message: existing.message.body,
          delivery: {
            messageId: existing.message.messageId,
            queuedAt: existing.message.queuedAt,
          },
        });
        if (!result.ok) throw new Error(result.error);
        const completed = await caller.completeHumanInput({
          ...lifecycleCall,
          requestId: existing.requestId,
        });
        if (!completed.ok) throw new Error(completed.error);
        return {
          status: "queued",
          taskId: task.taskId,
          agentId: coordinator.agentId,
          requestId: existing.requestId,
        };
      }
      const requestId = `${task.taskId}-human-${randomUUID()}`;
      const requestedAt = new Date().toISOString();
      const message = {
        messageId: `${requestId}-request`,
        agentId: coordinator.agentId,
        body: attachments.compose(agent.turn.wait_for_human_request(call.request)),
        queuedAt: requestedAt,
      };
      await this.eventBus.publishAndWait(AgentEvents.humanInput.requested, {
        requestId,
        taskId: task.taskId,
        agentId: caller.agentId,
        body: call.request,
        requestedAt,
        message,
      }, {
        occurredAt: requestedAt,
      });
      const result = await coordinator.sendMessage({
        message: message.body,
        delivery: {
          messageId: message.messageId,
          queuedAt: message.queuedAt,
        },
      });
      if (!result.ok) throw new Error(result.error);
      const completed = await caller.completeHumanInput({
        ...lifecycleCall,
        requestId,
      });
      if (!completed.ok) throw new Error(completed.error);
      return {
        status: "queued",
        taskId: task.taskId,
        agentId: coordinator.agentId,
        requestId,
      };
    } catch (error) {
      caller.abortHumanInput(lifecycleCall);
      throw error;
    }
  }

  private async handleRespondHumanInputToolCall(
    call: RespondHumanInputToolCall,
    caller: ScoutAgent,
  ): Promise<Record<string, unknown>> {
    if (caller.role !== ScoutAgentRoles.Coordinator) {
      throw new Error("RespondHumanInput is only available to the Coordinator agent.");
    }
    const task = this.taskStore.getTask(call.task_id);
    if (!task) throw new Error(`Unknown agent task: ${call.task_id}`);
    if (task.status !== AgentTaskStatuses.Running) {
      throw new Error(`Worker task ${task.taskId} cannot receive human input from status ${task.status}.`);
    }
    const target = this.registry.resolveAgent(task.agentId);
    const taskRequests = this.humanInputStore.listForTask(task.taskId);
    const requests = taskRequests.filter((request) =>
      request.taskId === task.taskId && !request.response
    );
    if (requests.length === 0) {
      const responded = taskRequests.find((request) =>
        request.taskId === task.taskId && request.response?.body === call.response
      );
      if (!responded?.response) {
        throw new Error(`Worker task ${task.taskId} has no unresolved human request.`);
      }
      const result = await target.sendMessage({
        taskId: task.taskId,
        message: responded.response.message.body,
        delivery: {
          messageId: responded.response.message.messageId,
          queuedAt: responded.response.message.queuedAt,
        },
      });
      if (!result.ok) throw new Error(result.error);
      return {
        status: "queued",
        taskId: task.taskId,
        agentId: target.agentId,
        requestId: responded.requestId,
      };
    }
    if (requests.length !== 1) {
      throw new Error(`Worker task ${task.taskId} must have exactly one unresolved human request.`);
    }
    const request = requests[0];
    if (!request) throw new Error(`Worker task ${task.taskId} has no unresolved human request.`);
    const respondedAt = new Date().toISOString();
    const message = {
      messageId: `${request.requestId}-response`,
      agentId: target.agentId,
      taskId: task.taskId,
      body: attachments.compose(agent.turn.human_response(call.response)),
      queuedAt: respondedAt,
    };
    await this.eventBus.publishAndWait(AgentEvents.humanInput.responded, {
      requestId: request.requestId,
      taskId: task.taskId,
      agentId: task.agentId,
      body: call.response,
      respondedAt,
      message,
    }, {
      occurredAt: respondedAt,
    });
    const result = await target.sendMessage({
      taskId: task.taskId,
      message: message.body,
      delivery: {
        messageId: message.messageId,
        queuedAt: message.queuedAt,
      },
    });
    if (!result.ok) throw new Error(result.error);
    return {
      status: "queued",
      taskId: task.taskId,
      agentId: target.agentId,
      requestId: request.requestId,
    };
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
        return this.handleRespondHumanInputToolCall(call, caller);
      case "SubmitTask":
        return this.handleSubmitTaskToolCall(call, caller, delivery);
      case "ArchiveTask":
        return this.handleArchiveTaskToolCall(call, caller);
      default:
        throw new Error(`Unsupported agent tool: ${String((call as { tool?: unknown }).tool)}`);
    }
  }

  private resolveAssignableWorker(call: AssignTaskToolCall): WorkerAgent {
    const agent = this.registry.resolveAgent(call.agent_id ?? call.subagent_type);
    if (!(agent instanceof WorkerAgent)) {
      throw new Error(`Agent ${agent.agentId} is not a Worker agent.`);
    }
    const worker = agent;
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
