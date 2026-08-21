import { randomUUID } from "node:crypto";
import type { DynamicToolCallInput } from "../../agent-server/types.js";
import { AgentEvents } from "../events/index.js";
import {
  AgentTaskStore,
  cloneAgentTaskState,
} from "../task/agent-task-store.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import { WorkerAgent } from "../roles/worker-agent.js";
import {
  AgentTaskDispositionKinds,
  AgentTaskStatuses,
  type AgentTaskDisposition,
  type AgentTaskState,
} from "../task/types.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import { canonicalizeAgentArtifactReferences } from "../task/artifact-references.js";
import { agent } from "../context/agent-attachments.js";
import { attachments } from "../context/attachments.js";
import { ScoutAgentRoles } from "../thread/types.js";
import type {
  RequestHumanInputToolCall,
  RespondHumanInputToolCall,
  SubmitTaskToolCall,
} from "../tools/agent-tools.js";

/** Result of forwarding a human-input request or response for a Worker Task. */
export interface AgentTaskHumanInputResult extends Record<string, unknown> {
  status: "accepted" | "queued";
  taskId: string;
  agentId: string;
  requestId: string;
}

/**
 * Applies Task commands, dispositions, and Human Input transitions to the
 * shared Task state. It does not decide how a runner schedules its turns.
 */
export class AgentTaskBackend {
  private readonly registry: RunScope["agentRegistry"];
  private readonly taskStore: AgentTaskStore;
  private readonly stepStore: RunScope["stepStore"];
  private readonly humanInputStore: RunScope["humanInputStore"];
  private readonly eventBus: RunScope["eventBus"];

  constructor() {
    const scope = currentRunScope();
    this.registry = scope.agentRegistry;
    this.taskStore = scope.taskStore;
    this.stepStore = scope.stepStore;
    this.humanInputStore = scope.humanInputStore;
    this.eventBus = scope.eventBus;
  }

  async submitTask(input: {
    call: SubmitTaskToolCall;
    caller: WorkerAgent;
    delivery: DynamicToolCallInput;
  }): Promise<AgentTaskState> {
    const activeTask = input.caller.snapshot().activeTask;
    if (!activeTask || activeTask.status !== AgentTaskStatuses.Running) {
      throw new Error(`Worker agent ${input.caller.agentId} has no running task for lifecycle tool.`);
    }
    const unresolvedRequest = this.humanInputStore.listForTask(activeTask.taskId).find((request) =>
      !request.response
    );
    if (unresolvedRequest) {
      throw new Error(
        `Worker task ${activeTask.taskId} cannot be submitted while human request ${unresolvedRequest.requestId} is unresolved.`,
      );
    }
    const { task, stepId } = this.resolveRunningWorkerTaskStep(input.caller, input.delivery);
    return this.recordDisposition(task, {
      kind: AgentTaskDispositionKinds.HandoffSubmitted,
      stepId,
      turnId: input.delivery.turnId,
      callId: input.delivery.callId,
      timestamp: new Date().toISOString(),
      outcome: canonicalizeAgentArtifactReferences(input.call.outcome, {
        runRoot: input.caller.mount.runRoot,
        artifactRoot: input.caller.mount.artifactRoot,
      }),
    });
  }

  async requestHumanInput(input: {
    call: RequestHumanInputToolCall;
    caller: WorkerAgent;
    delivery: DynamicToolCallInput;
  }): Promise<AgentTaskHumanInputResult> {
    const { task, stepId } = this.resolveRunningWorkerTaskStep(input.caller, input.delivery);
    const recordedDisposition = task.dispositions.find((disposition) =>
      disposition.stepId === stepId
    );
    const coordinator = this.resolveCoordinator(input.caller.agentId);
    if (recordedDisposition?.kind === AgentTaskDispositionKinds.WaitingForHuman) {
      if (
        recordedDisposition.callId !== input.delivery.callId
        || recordedDisposition.request !== input.call.request
      ) {
        throw new Error(`Worker task ${task.taskId} step ${stepId} already has a different disposition.`);
      }
      const recordedRequest = this.humanInputStore.listForTask(task.taskId).find((request) =>
        request.requestId === recordedDisposition.requestId
      );
      if (!recordedRequest) {
        throw new Error(
          `Worker task ${task.taskId} is missing recorded human request ${recordedDisposition.requestId}.`,
        );
      }
      const requestClosed = recordedRequest.requestConsumption !== undefined
        || recordedRequest.response !== undefined;
      if (!requestClosed) {
        await this.sendRecordedMessage(coordinator, recordedRequest.message);
      }
      return {
        status: requestClosed ? "accepted" : "queued",
        taskId: task.taskId,
        agentId: coordinator.agentId,
        requestId: recordedRequest.requestId,
      };
    }
    if (recordedDisposition) {
      throw new Error(`Worker task ${task.taskId} step ${stepId} already recorded disposition ${recordedDisposition.kind}.`);
    }

    const existing = this.humanInputStore.listForTask(task.taskId).find((request) =>
      !request.response
    );
    if (existing) {
      if (existing.body !== input.call.request) {
        throw new Error(`Worker task ${task.taskId} already has unresolved human request ${existing.requestId}.`);
      }
      if (!existing.requestConsumption) {
        await this.sendRecordedMessage(coordinator, existing.message);
      }
      return {
        status: existing.requestConsumption ? "accepted" : "queued",
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
      body: attachments.compose(agent.turn.wait_for_human_request(input.call.request)),
      queuedAt: requestedAt,
    };
    await this.eventBus.publishAndWait(AgentEvents.humanInput.requested, {
      requestId,
      taskId: task.taskId,
      agentId: input.caller.agentId,
      body: input.call.request,
      requestedAt,
      message,
    }, { occurredAt: requestedAt });
    await this.recordHumanInputDisposition(task, stepId, input, requestId);
    await this.sendRecordedMessage(coordinator, message);
    return {
      status: "queued",
      taskId: task.taskId,
      agentId: coordinator.agentId,
      requestId,
    };
  }

  async respondHumanInput(call: RespondHumanInputToolCall): Promise<AgentTaskHumanInputResult> {
    const task = this.getAgentTask(call.task_id);
    if (task.status !== AgentTaskStatuses.Running) {
      throw new Error(`Worker task ${task.taskId} cannot receive human input from status ${task.status}.`);
    }
    const target = this.registry.resolveAgent(task.agentId);
    const taskRequests = this.humanInputStore.listForTask(task.taskId);
    const unresolved = taskRequests.filter((request) => !request.response);
    if (unresolved.length === 0) {
      const responded = taskRequests.find((request) => request.response?.body === call.response);
      if (!responded?.response) {
        throw new Error(`Worker task ${task.taskId} has no unresolved human request.`);
      }
      this.requireWaitingDisposition(task, responded.requestId);
      if (!responded.response.consumption) {
        await this.sendRecordedMessage(target, responded.response.message, task.taskId);
      }
      return {
        status: responded.response.consumption ? "accepted" : "queued",
        taskId: task.taskId,
        agentId: target.agentId,
        requestId: responded.requestId,
      };
    }
    if (unresolved.length !== 1) {
      throw new Error(`Worker task ${task.taskId} must have exactly one unresolved human request.`);
    }
    const request = unresolved[0];
    if (!request) throw new Error(`Worker task ${task.taskId} has no unresolved human request.`);
    this.requireWaitingDisposition(task, request.requestId);
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
    }, { occurredAt: respondedAt });
    await this.sendRecordedMessage(target, message, task.taskId);
    return {
      status: "queued",
      taskId: task.taskId,
      agentId: target.agentId,
      requestId: request.requestId,
    };
  }

  async stopAgentTask(
    target: string,
    reason = "任务已被 Coordinator 停止。",
  ): Promise<AgentTaskState> {
    const resolved = this.resolveTaskTarget(target);
    if (!(resolved.agent instanceof WorkerAgent)) {
      throw new Error(`Task ${resolved.taskId} is not owned by a Worker agent.`);
    }
    return resolved.agent.stopTask(resolved.taskId, reason);
  }

  getAgentTask(taskId: string): AgentTaskState {
    const task = this.taskStore.getTask(taskId);
    if (!task) throw new Error(`Unknown agent task: ${taskId}`);
    return task;
  }

  async archiveAgentTask(taskId: string): Promise<AgentTaskState> {
    const task = this.getAgentTask(taskId);
    const agent = this.registry.resolveAgent(task.agentId);
    if (!(agent instanceof WorkerAgent)) {
      throw new Error(`Task ${taskId} is not owned by a Worker agent.`);
    }
    return agent.archiveTask(taskId);
  }

  hasRunningAgentTasks(): boolean {
    return this.taskStore.hasRunningTasks();
  }

  hasOpenAgentTasks(): boolean {
    return this.taskStore.hasOpenTasks();
  }

  private resolveTaskTarget(target: string): { agent: ScoutAgent; taskId: string } {
    const task = this.taskStore.getTask(target);
    if (task) {
      return {
        agent: this.registry.resolveAgent(task.agentId),
        taskId: task.taskId,
      };
    }
    const agent = this.registry.resolveAgent(target);
    const active = this.taskStore.findActiveTaskForAgent(agent.agentId);
    if (!active) {
      throw new Error(`Agent ${agent.agentId} has no active task.`);
    }
    return {
      agent,
      taskId: active.taskId,
    };
  }

  private resolveRunningWorkerTaskStep(
    caller: WorkerAgent,
    delivery: DynamicToolCallInput,
  ): { task: AgentTaskState; stepId: string } {
    const task = caller.snapshot().activeTask;
    if (!task || task.status !== AgentTaskStatuses.Running) {
      throw new Error(`Worker agent ${caller.agentId} has no running task for lifecycle tool.`);
    }
    caller.assertOwnsActiveTurn({
      threadId: delivery.threadId,
      turnId: delivery.turnId,
    });
    const stepId = task.stepIds.at(-1);
    if (!stepId) throw new Error(`Worker task ${task.taskId} has no current step.`);
    const step = this.stepStore.getStep(stepId);
    if (!step) throw new Error(`Unknown agent step: ${stepId}`);
    if (
      step.agentId !== caller.agentId
      || step.taskId !== task.taskId
      || step.status !== "running"
    ) {
      throw new Error(`Worker task ${task.taskId} has no running step for lifecycle tool.`);
    }
    if (step.turnId && step.turnId !== delivery.turnId) {
      throw new Error(`Agent step ${step.stepId} belongs to turn ${step.turnId}, not ${delivery.turnId}.`);
    }
    return { task: this.getAgentTask(task.taskId), stepId };
  }

  private requireWaitingDisposition(
    task: AgentTaskState,
    requestId: string,
  ): AgentTaskDisposition {
    const matches = task.dispositions.filter((disposition) =>
      disposition.kind === AgentTaskDispositionKinds.WaitingForHuman
      && disposition.requestId === requestId
    );
    if (matches.length !== 1 || !matches[0]) {
      throw new Error(`Worker task ${task.taskId} has no disposition waiting on human request ${requestId}.`);
    }
    return matches[0];
  }

  private async recordHumanInputDisposition(
    task: AgentTaskState,
    stepId: string,
    input: {
      call: RequestHumanInputToolCall;
      caller: WorkerAgent;
      delivery: DynamicToolCallInput;
    },
    requestId: string,
  ): Promise<void> {
    await this.recordDisposition(task, {
      kind: AgentTaskDispositionKinds.WaitingForHuman,
      stepId,
      turnId: input.delivery.turnId,
      callId: input.delivery.callId,
      timestamp: new Date().toISOString(),
      request: input.call.request,
      requestId,
    });
  }

  private async recordDisposition(
    task: AgentTaskState,
    disposition: AgentTaskDisposition,
  ): Promise<AgentTaskState> {
    const recordedTask = this.taskStore.recordDisposition(task.taskId, disposition);
    await this.eventBus.publishAndWait(AgentEvents.task.dispositionRecorded, {
      task: recordedTask,
      disposition,
    }, { occurredAt: disposition.timestamp });
    return recordedTask;
  }

  private resolveCoordinator(workerAgentId: string) {
    const coordinator = this.registry.listAgents().find((candidate) =>
      candidate.role === ScoutAgentRoles.Coordinator
    );
    if (!coordinator) {
      throw new Error(`Worker agent ${workerAgentId} cannot find the Coordinator agent.`);
    }
    return coordinator;
  }

  private async sendRecordedMessage(
    target: ReturnType<RunScope["agentRegistry"]["resolveAgent"]>,
    message: { messageId: string; body: string; queuedAt: string },
    taskId?: string,
  ): Promise<void> {
    const delivered = await target.sendMessage({
      taskId,
      message: message.body,
      delivery: {
        messageId: message.messageId,
        queuedAt: message.queuedAt,
      },
    });
    if (!delivered.ok) throw new Error(delivered.error);
  }
}

/** Returns a detached task snapshot suitable for event or persistence consumers. */
export function cloneTask(task: AgentTaskState): AgentTaskState {
  return cloneAgentTaskState(task);
}
