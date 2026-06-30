import {
  SystemEvents,
  type EventBus,
  type ScoutEvent,
} from "../../core/events/index.js";
import type {
  AppServerPlanState,
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
  AppServerThreadGoalState,
} from "../../agent-server/codex/app-server-event-store.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import {
  AgentTaskStore,
  cloneAgentTaskState,
} from "../task/agent-task-store.js";
import type {
  AgentTaskEventPayload,
  AgentTaskSystemEvent,
} from "../task/task-events.js";
import type { CoordinatorPromptReadyPayload } from "../orchestration/orchestration-events.js";
import type {
  AgentTaskState,
  AgentUserInputResponse,
  SendAgentMessageInput,
} from "../task/types.js";
import type { AgentRegistry } from "../lifecycle/agent-registry.js";
import type {
  AgentProvider,
  AssignBackendAgentTaskInput,
} from "./types.js";

export interface AgentTaskBackendOptions {
  registry: AgentRegistry;
  taskStore: AgentTaskStore;
  eventBus: EventBus;
  agentProvider: AgentProvider;
  logger: {
    info(input: unknown): void;
    warn(input: unknown): void;
  };
  onTaskChanged?: () => void;
}

export class AgentTaskBackend {
  private readonly registry: AgentRegistry;
  private readonly taskStore: AgentTaskStore;
  private readonly eventBus: EventBus;
  private readonly agentProvider: AgentProvider;
  private readonly logger: AgentTaskBackendOptions["logger"];
  private readonly onTaskChanged?: () => void;
  private taskSequence = 0;

  constructor(options: AgentTaskBackendOptions) {
    this.registry = options.registry;
    this.taskStore = options.taskStore;
    this.eventBus = options.eventBus;
    this.agentProvider = options.agentProvider;
    this.logger = options.logger;
    this.onTaskChanged = options.onTaskChanged;
    this.subscribeToTaskEvents();
  }

  assignAgentTask(input: AssignBackendAgentTaskInput): AgentTaskState {
    const agent = input.agentId
      ? this.registry.resolveAgent(input.agentId)
      : this.agentProvider.getOrCreateWorker({ role: input.subagentType });
    if (agent.role !== input.subagentType) {
      throw new Error(`Agent ${agent.agentId} is ${agent.role}, not ${input.subagentType}.`);
    }
    const task = agent.task.assignTask({
      ...input,
      taskId: this.nextTaskId(),
      agentId: agent.agentId,
    });
    this.syncTaskSnapshot(task);
    return task;
  }

  sendAgentMessage(input: SendAgentMessageInput): AgentTaskState {
    const target = this.resolveTaskTarget(input.target);
    const task = target.agent.task.queueMessage({
      taskId: target.taskId,
      message: input.message,
    });
    this.syncTaskSnapshot(task);
    return task;
  }

  stopAgentTask(target: string, reason = "任务已被 Coordinator 停止。"): AgentTaskState {
    const resolved = this.resolveTaskTarget(target);
    const task = resolved.agent.task.stopTask(resolved.taskId, reason);
    this.syncTaskSnapshot(task);
    return task;
  }

  handleUserInputResponse(input: {
    taskId: string;
    requestId: string;
    response: string;
  }): AgentTaskState {
    const target = this.resolveTaskTarget(input.taskId);
    const current = this.taskStore.requireTask(target.taskId);
    const response: AgentUserInputResponse = {
      requestId: input.requestId,
      agentId: current.agentId,
      taskId: current.taskId,
      response: input.response,
      createdAt: new Date().toISOString(),
    };
    const task = target.agent.task.applyUserInputResponse(response);
    this.eventBus.publish(SystemEvents.task.humanInputResponded, {
      task,
      data: {
        requestId: input.requestId,
      },
    } satisfies AgentTaskEventPayload);
    this.syncTaskSnapshot(task);
    return task;
  }

  getAgentTask(taskId: string): AgentTaskState {
    return this.taskStore.requireTask(taskId);
  }

  hasRunningAgentTasks(): boolean {
    if (this.taskStore.hasRunningTasks()) {
      return true;
    }
    return this.registry.listAgents().some((agent) => agent.task.hasRunningTasks());
  }

  syncTaskSnapshot(_task: AgentTaskState): void {
    this.onTaskChanged?.();
  }

  consumeAppServerTimelineEntry(
    agent: ScoutAgent,
    entry: AppServerTimelineEntry,
    resolved: AppServerResolvedTimelineEntry,
  ): AgentTaskTimelineProjection | undefined {
    const activeTask = this.taskStore.findActiveTaskForAgent(agent.agentId);
    if (
      entry.stream === "item"
      && (entry.kind === "item_started" || entry.kind === "item_completed")
      && resolved.progressItem
    ) {
      return {
        kind: "progress",
        agent,
        activeTask,
        entry,
        progressItem: resolved.progressItem,
      };
    }
    if (entry.stream === "plan" && resolved.plan && activeTask) {
      const updated = this.applyPlanUpdate(activeTask, resolved.plan, entry);
      return {
        kind: "plan_updated",
        agent,
        task: updated,
        entry,
        plan: resolved.plan,
      };
    }
    if (entry.stream === "state" && entry.kind === "goal_updated" && resolved.goal && activeTask) {
      const updated = this.applyGoalUpdate(activeTask, resolved.goal, entry);
      return {
        kind: "goal_updated",
        agent,
        task: updated,
        entry,
        goal: resolved.goal,
      };
    }
    if (entry.stream === "state" && entry.kind === "token_usage_updated") {
      return {
        kind: "token_usage_updated",
        agent,
        activeTask,
        entry,
        tokenUsage: resolved.tokenUsage,
      };
    }
    return undefined;
  }

  resolveAgentTask(agent: ScoutAgent, taskId: string | undefined, context: string): AgentTaskState {
    if (taskId) {
      return this.taskStore.requireAgentTask(agent.agentId, taskId);
    }
    const active = this.taskStore.findActiveTaskForAgent(agent.agentId);
    if (!active) throw new Error(`Agent ${agent.agentId} has no active task for ${context}.`);
    return active;
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

  private subscribeToTaskEvents(): void {
    this.eventBus.subscribe(SystemEvents.task, (event) => {
      this.handleTaskEvent(event as ScoutEvent<AgentTaskEventPayload>);
    });
  }

  private handleTaskEvent(event: ScoutEvent<AgentTaskEventPayload>): void {
    const { task, data } = event.payload;
    this.logger.info({
      module: "agent.task",
      event: event.key.routeKey,
      agentId: task.agentId,
      taskId: task.taskId,
      data: {
        eventKey: event.key.routeKey,
        status: task.status,
        role: task.role,
        description: task.description,
        ...asLogObject(data),
      },
    });
    this.onTaskChanged?.();
    this.eventBus.publish(SystemEvents.orchestration.coordinatorPromptReady, {
      sourceEvents: [event as AgentTaskSystemEvent],
    } satisfies CoordinatorPromptReadyPayload);
  }

  private nextTaskId(): string {
    this.taskSequence += 1;
    return `agent-task-${String(this.taskSequence).padStart(4, "0")}`;
  }

  private applyGoalUpdate(
    task: AgentTaskState,
    goal: AppServerThreadGoalState,
    entry: AppServerTimelineEntry,
  ): AgentTaskState {
    const updated: AgentTaskState = {
      ...task,
      goal,
      updatedAt: new Date().toISOString(),
    };
    this.taskStore.updateTask(updated.taskId, () => updated);
    this.logger.info({
      module: "agent.task",
      event: "goal_updated",
      agentId: updated.agentId,
      taskId: updated.taskId,
      data: {
        status: updated.status,
        role: updated.role,
        description: updated.description,
        seq: entry.seq,
        goal,
      },
    });
    this.eventBus.publish(SystemEvents.task.goalUpdated, {
      task: cloneAgentTaskState(updated),
      data: {
        seq: entry.seq,
        goal,
      },
    } satisfies AgentTaskEventPayload);
    return updated;
  }

  private applyPlanUpdate(
    task: AgentTaskState,
    plan: AppServerPlanState,
    entry: AppServerTimelineEntry,
  ): AgentTaskState {
    const updated: AgentTaskState = {
      ...task,
      plan,
      updatedAt: new Date().toISOString(),
    };
    this.taskStore.updateTask(updated.taskId, () => updated);
    this.logger.info({
      module: "agent.task",
      event: "plan_updated",
      agentId: updated.agentId,
      taskId: updated.taskId,
      data: {
        status: updated.status,
        role: updated.role,
        description: updated.description,
        seq: entry.seq,
        plan,
      },
    });
    this.eventBus.publish(SystemEvents.task.planUpdated, {
      task: cloneAgentTaskState(updated),
      data: {
        seq: entry.seq,
        plan,
      },
    } satisfies AgentTaskEventPayload);
    return updated;
  }
}

export type AgentTaskTimelineProjection =
  | {
    kind: "progress";
    agent: ScoutAgent;
    activeTask?: AgentTaskState;
    entry: AppServerTimelineEntry;
    progressItem: NonNullable<AppServerResolvedTimelineEntry["progressItem"]>;
  }
  | {
    kind: "plan_updated";
    agent: ScoutAgent;
    task: AgentTaskState;
    entry: AppServerTimelineEntry;
    plan: AppServerPlanState;
  }
  | {
    kind: "goal_updated";
    agent: ScoutAgent;
    task: AgentTaskState;
    entry: AppServerTimelineEntry;
    goal: AppServerThreadGoalState;
  }
  | {
    kind: "token_usage_updated";
    agent: ScoutAgent;
    activeTask?: AgentTaskState;
    entry: AppServerTimelineEntry;
    tokenUsage: AppServerResolvedTimelineEntry["tokenUsage"];
  };

export function cloneTask(task: AgentTaskState): AgentTaskState {
  return cloneAgentTaskState(task);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asLogObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}
