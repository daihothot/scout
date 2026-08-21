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
import { AgentHumanInputBackend } from "./agent-human-input-backend.js";
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
 * Applies Task commands and dispositions, and coordinates Task validation
 * around the Human Input backend. It does not schedule runner turns.
 */
export class AgentTaskBackend {
  private readonly registry: RunScope["agentRegistry"];
  private readonly taskStore: AgentTaskStore;
  private readonly stepStore: RunScope["stepStore"];
  private readonly eventBus: RunScope["eventBus"];
  private readonly humanInputBackend: AgentHumanInputBackend;

  constructor(input: { humanInputBackend?: AgentHumanInputBackend } = {}) {
    const scope = currentRunScope();
    this.registry = scope.agentRegistry;
    this.taskStore = scope.taskStore;
    this.stepStore = scope.stepStore;
    this.eventBus = scope.eventBus;
    this.humanInputBackend = input.humanInputBackend ?? new AgentHumanInputBackend();
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
    const unresolvedRequest = this.humanInputBackend.findUnresolvedRequests(activeTask.taskId)[0];
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
    if (recordedDisposition?.kind === AgentTaskDispositionKinds.WaitingForHuman) {
      if (
        recordedDisposition.callId !== input.delivery.callId
        || recordedDisposition.request !== input.call.request
      ) {
        throw new Error(`Worker task ${task.taskId} step ${stepId} already has a different disposition.`);
      }
      const result = await this.humanInputBackend.request({
        taskId: task.taskId,
        stepId,
        worker: input.caller,
        request: input.call.request,
        requestId: recordedDisposition.requestId,
      });
      if (result.message) {
        const coordinator = this.humanInputBackend.resolveAgent(result.agentId);
        await this.humanInputBackend.deliverMessage(coordinator, result.message);
      }
      return toTaskHumanInputResult(result);
    }
    if (recordedDisposition) {
      throw new Error(`Worker task ${task.taskId} step ${stepId} already recorded disposition ${recordedDisposition.kind}.`);
    }

    const result = await this.humanInputBackend.request({
      taskId: task.taskId,
      stepId,
      worker: input.caller,
      request: input.call.request,
    });
    if (result.created) {
      await this.recordHumanInputDisposition(task, stepId, input, result.requestId);
    }
    if (result.message) {
      const coordinator = this.humanInputBackend.resolveAgent(result.agentId);
      await this.humanInputBackend.deliverMessage(coordinator, result.message);
    }
    return toTaskHumanInputResult(result);
  }

  async respondHumanInput(input: {
    call: RespondHumanInputToolCall;
    caller: ScoutAgent;
    delivery: DynamicToolCallInput;
  }): Promise<AgentTaskHumanInputResult> {
    const { call, caller, delivery } = input;
    caller.assertOwnsActiveTurn({
      threadId: delivery.threadId,
      turnId: delivery.turnId,
    });
    const runningSteps = this.stepStore.list({ agentId: caller.agentId }).filter((step) =>
      step.status === "running"
    );
    if (runningSteps.length !== 1 || !runningSteps[0]) {
      throw new Error(`Coordinator agent ${caller.agentId} must have exactly one running step for human response.`);
    }
    const responseStep = runningSteps[0];
    if (responseStep.turnId && responseStep.turnId !== delivery.turnId) {
      throw new Error(
        `Agent step ${responseStep.stepId} belongs to turn ${responseStep.turnId}, not ${delivery.turnId}.`,
      );
    }
    const task = this.getAgentTask(call.task_id);
    if (task.status !== AgentTaskStatuses.Running) {
      throw new Error(`Worker task ${task.taskId} cannot receive human input from status ${task.status}.`);
    }
    const target = this.humanInputBackend.resolveAgent(task.agentId);
    const responseTarget = this.humanInputBackend.resolveResponse(task.taskId, call.response);
    this.requireWaitingDisposition(task, responseTarget.requestId);
    if (responseTarget.response) {
      if (!responseTarget.response.consumption) {
        await this.humanInputBackend.deliverMessage(target, responseTarget.response.message, task.taskId);
      }
      return {
        status: responseTarget.response.consumption ? "accepted" : "queued",
        taskId: task.taskId,
        agentId: target.agentId,
        requestId: responseTarget.requestId,
      };
    }
    const { message } = await this.humanInputBackend.publishResponse({
      requestId: responseTarget.requestId,
      stepId: responseStep.stepId,
      taskId: task.taskId,
      agentId: task.agentId,
      target,
      response: call.response,
    });
    await this.humanInputBackend.deliverMessage(target, message, task.taskId);
    return {
      status: "queued",
      taskId: task.taskId,
      agentId: target.agentId,
      requestId: responseTarget.requestId,
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

}

function toTaskHumanInputResult(
  result: Awaited<ReturnType<AgentHumanInputBackend["request"]>>,
): AgentTaskHumanInputResult {
  return {
    status: result.status,
    taskId: result.taskId,
    agentId: result.agentId,
    requestId: result.requestId,
  };
}

/** Returns a detached task snapshot suitable for event or persistence consumers. */
export function cloneTask(task: AgentTaskState): AgentTaskState {
  return cloneAgentTaskState(task);
}
