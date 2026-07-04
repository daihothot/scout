import {
  AgentTaskStatuses,
  type AgentTaskState,
  type AgentTaskStatus,
} from "./types.js";

export const ActiveAgentTaskStatuses = [
  AgentTaskStatuses.Queued,
  AgentTaskStatuses.Running,
  AgentTaskStatuses.WaitingForHumanInput,
] as const satisfies AgentTaskStatus[];

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

  hasWaitingHumanInputTasks(): boolean {
    return [...this.tasks.values()].some((task) => task.status === AgentTaskStatuses.WaitingForHumanInput);
  }
}

export function isActiveAgentTaskStatus(status: AgentTaskStatus): boolean {
  return ActiveAgentTaskStatuses.includes(status as typeof ActiveAgentTaskStatuses[number]);
}

export function cloneAgentTaskState(task: AgentTaskState): AgentTaskState {
  return {
    ...task,
    usage: task.usage ? { ...task.usage } : undefined,
    thread: task.thread ? { ...task.thread } : undefined,
    goal: task.goal ? cloneJson(task.goal) : undefined,
    plan: task.plan ? cloneJson(task.plan) : undefined,
    planRecords: task.planRecords?.map((plan) => cloneJson(plan)),
    steps: task.steps?.map((step) => ({
      ...step,
      humanInputRequest: step.humanInputRequest ? {
        ...step.humanInputRequest,
        options: step.humanInputRequest.options ? [...step.humanInputRequest.options] : undefined,
      } : undefined,
      humanInputResponse: step.humanInputResponse ? { ...step.humanInputResponse } : undefined,
      toolCalls: step.toolCalls.map((toolCall) => ({ ...toolCall })),
      protocolWarnings: step.protocolWarnings ? [...step.protocolWarnings] : undefined,
    })),
    outcome: task.outcome ? {
      ...task.outcome,
      artifactRefs: [...task.outcome.artifactRefs],
      evidenceRefs: [...task.outcome.evidenceRefs],
    } : undefined,
  };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
