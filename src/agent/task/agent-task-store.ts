import type { AgentTaskState, AgentTaskStatus } from "./types.js";

export const ActiveAgentTaskStatuses = [
  "queued",
  "running",
  "waiting_for_human_input",
  "waiting_for_coordinator",
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

  requireTask(taskId: string): AgentTaskState {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Unknown agent task: ${taskId}`);
    return task;
  }

  getAgentTask(agentId: string, taskId: string): AgentTaskState | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.agentId !== agentId) return undefined;
    return cloneAgentTaskState(task);
  }

  requireAgentTask(agentId: string, taskId: string): AgentTaskState {
    const task = this.getAgentTask(agentId, taskId);
    if (!task) throw new Error(`Task ${taskId} does not belong to agent ${agentId}.`);
    return task;
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
    return [...this.tasks.values()].some((task) => task.status === "queued" || task.status === "running");
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
    userInputRequest: task.userInputRequest ? {
      ...task.userInputRequest,
      options: task.userInputRequest.options ? [...task.userInputRequest.options] : undefined,
    } : undefined,
    humanInputRequests: task.humanInputRequests?.map((request) => ({
      ...request,
      options: request.options ? [...request.options] : undefined,
    })),
    humanInputResponses: task.humanInputResponses?.map((response) => ({ ...response })),
    steps: task.steps?.map((step) => ({
      ...step,
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
