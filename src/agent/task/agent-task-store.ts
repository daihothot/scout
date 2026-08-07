import {
  AgentTaskStatuses,
  type AgentTaskDisposition,
  type AgentTaskState,
  type AgentTaskStatus,
} from "./types.js";

/** Task statuses that remain visible to the agent orchestration layer. */
export const ActiveAgentTaskStatuses = [
  AgentTaskStatuses.Queued,
  AgentTaskStatuses.Running,
  AgentTaskStatuses.Done,
] as const satisfies AgentTaskStatus[];

/** In-memory task authority that returns detached state snapshots. */
export class AgentTaskStore {
  private readonly tasks = new Map<string, AgentTaskState>();
  private readonly taskIdsByAgent = new Map<string, string[]>();

  addTask(task: AgentTaskState): AgentTaskState {
    if (this.tasks.has(task.taskId)) {
      throw new Error(`Duplicate agent task id: ${task.taskId}`);
    }
    const stored = cloneAgentTaskState(task);
    this.tasks.set(stored.taskId, stored);
    const agentTaskIds = this.taskIdsByAgent.get(stored.agentId) ?? [];
    this.taskIdsByAgent.set(stored.agentId, [...agentTaskIds, stored.taskId]);
    return cloneAgentTaskState(stored);
  }

  getTask(taskId: string): AgentTaskState | undefined {
    const task = this.tasks.get(taskId);
    return task ? cloneAgentTaskState(task) : undefined;
  }

  updateTask(taskId: string, update: (task: AgentTaskState) => AgentTaskState): AgentTaskState {
    const current = this.tasks.get(taskId);
    if (!current) throw new Error(`Unknown agent task: ${taskId}`);
    const next = cloneAgentTaskState(update(cloneAgentTaskState(current)));
    if (next.taskId !== taskId) {
      throw new Error(`Cannot change task id from ${taskId} to ${next.taskId}.`);
    }
    if (next.agentId !== current.agentId) {
      throw new Error(`Cannot move task ${taskId} from agent ${current.agentId} to ${next.agentId}.`);
    }
    this.tasks.set(taskId, next);
    return cloneAgentTaskState(next);
  }

  recordTaskDisposition(taskId: string, disposition: AgentTaskDisposition): AgentTaskState {
    return this.updateTask(taskId, (task) => {
      const steps = task.steps ?? [];
      const stepIndex = steps.findIndex((step) => step.stepId === disposition.stepId);
      if (stepIndex < 0) {
        throw new Error(`Task ${taskId} has no step ${disposition.stepId} for disposition.`);
      }
      const step = steps[stepIndex];
      if (!step) {
        throw new Error(`Task ${taskId} has no step ${disposition.stepId} for disposition.`);
      }
      if (step.turnId && step.turnId !== disposition.turnId) {
        throw new Error(
          `Task step ${step.stepId} belongs to turn ${step.turnId}, not ${disposition.turnId}.`,
        );
      }
      if (step.disposition) {
        if (sameAgentTaskDisposition(step.disposition, disposition)) return task;
        throw new Error(`Task step ${step.stepId} already has a different disposition.`);
      }
      return {
        ...task,
        steps: steps.map((candidate, index) => index === stepIndex
          ? { ...candidate, disposition: { ...disposition } }
          : candidate),
        updatedAt: disposition.timestamp,
      };
    });
  }

  removeTask(taskId: string): AgentTaskState {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown agent task: ${taskId}`);
    this.tasks.delete(taskId);
    const remainingTaskIds = (this.taskIdsByAgent.get(task.agentId) ?? [])
      .filter((currentTaskId) => currentTaskId !== taskId);
    if (remainingTaskIds.length > 0) {
      this.taskIdsByAgent.set(task.agentId, remainingTaskIds);
    } else {
      this.taskIdsByAgent.delete(task.agentId);
    }
    return cloneAgentTaskState(task);
  }

  listTasks(input: { agentId?: string } = {}): AgentTaskState[] {
    if (!input.agentId) {
      return [...this.tasks.values()].map(cloneAgentTaskState);
    }
    return (this.taskIdsByAgent.get(input.agentId) ?? [])
      .map((taskId) => this.tasks.get(taskId))
      .filter(isDefined)
      .map(cloneAgentTaskState);
  }

  findActiveTaskForAgent(agentId: string): AgentTaskState | undefined {
    return this.listTasks({ agentId }).find((task) => isActiveAgentTaskStatus(task.status));
  }

  hasRunningTasks(): boolean {
    return [...this.tasks.values()].some((task) =>
      task.status === AgentTaskStatuses.Queued || task.status === AgentTaskStatuses.Running
    );
  }

  hasOpenTasks(): boolean {
    return [...this.tasks.values()].some((task) => isActiveAgentTaskStatus(task.status));
  }
}

/** Whether a task is still open to orchestration or resumption. */
export function isActiveAgentTaskStatus(status: AgentTaskStatus): boolean {
  return ActiveAgentTaskStatuses.includes(status as typeof ActiveAgentTaskStatuses[number]);
}

/** Deep-clones task state before crossing a store or event boundary. */
export function cloneAgentTaskState(task: AgentTaskState): AgentTaskState {
  return {
    ...task,
    usage: task.usage ? { ...task.usage } : undefined,
    plan: task.plan ? cloneJson(task.plan) : undefined,
    planRecords: task.planRecords?.map((plan) => cloneJson(plan)),
    steps: task.steps?.map((step) => ({
      ...step,
      humanInputRequest: step.humanInputRequest ? { ...step.humanInputRequest } : undefined,
      humanInputResponse: step.humanInputResponse ? { ...step.humanInputResponse } : undefined,
      disposition: step.disposition ? { ...step.disposition } : undefined,
      toolCalls: step.toolCalls.map((toolCall) => ({ ...toolCall })),
      protocolWarnings: step.protocolWarnings ? [...step.protocolWarnings] : undefined,
    })),
  };
}

/** Compares two lifecycle dispositions for idempotent event replay. */
export function sameAgentTaskDisposition(
  left: AgentTaskDisposition,
  right: AgentTaskDisposition,
): boolean {
  if (
    left.kind !== right.kind
    || left.stepId !== right.stepId
    || left.turnId !== right.turnId
    || left.callId !== right.callId
  ) {
    return false;
  }
  if (
    left.kind === "handoff_submitted"
    && right.kind === "handoff_submitted"
  ) {
    return left.outcome === right.outcome;
  }
  if (
    left.kind === "protocol_violation"
    && right.kind === "protocol_violation"
  ) {
    return left.reason === right.reason;
  }
  return left.kind === "waiting_for_human"
    && right.kind === "waiting_for_human"
    && left.requestId === right.requestId
    && left.request === right.request;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
