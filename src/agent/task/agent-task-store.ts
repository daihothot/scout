import {
  AgentTaskDispositionKinds,
  type AgentTaskDisposition,
  AgentTaskStatuses,
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

  recordDisposition(taskId: string, disposition: AgentTaskDisposition): AgentTaskState {
    return this.updateTask(taskId, (task) => {
      if (!task.stepIds.includes(disposition.stepId)) {
        throw new Error(`Task ${taskId} does not own Agent step ${disposition.stepId}.`);
      }
      const existing = task.dispositions.find((candidate) =>
        candidate.stepId === disposition.stepId
      );
      if (existing) {
        const sameIdentity = existing.kind === disposition.kind
          && existing.turnId === disposition.turnId
          && existing.callId === disposition.callId;
        let samePayload = false;
        if (
          existing.kind === AgentTaskDispositionKinds.HandoffSubmitted
          && disposition.kind === AgentTaskDispositionKinds.HandoffSubmitted
        ) {
          samePayload = existing.outcome === disposition.outcome;
        } else if (
          existing.kind === AgentTaskDispositionKinds.WaitingForHuman
          && disposition.kind === AgentTaskDispositionKinds.WaitingForHuman
        ) {
          samePayload = existing.requestId === disposition.requestId
            && existing.request === disposition.request;
        } else if (
          existing.kind === AgentTaskDispositionKinds.ProtocolViolation
          && disposition.kind === AgentTaskDispositionKinds.ProtocolViolation
        ) {
          samePayload = existing.reason === disposition.reason;
        }
        if (sameIdentity && samePayload) return task;
        throw new Error(`Task ${taskId} step ${disposition.stepId} already has a different disposition.`);
      }
      return {
        ...task,
        dispositions: [...task.dispositions, { ...disposition }],
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
    stepIds: [...task.stepIds],
    dispositions: task.dispositions.map((disposition) => ({ ...disposition })),
    usage: task.usage ? { ...task.usage } : undefined,
  };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
