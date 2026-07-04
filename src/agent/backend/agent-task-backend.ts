import {
  type EventBus,
  type ScoutEvent,
} from "../../core/events/index.js";
import { AgentEvents } from "../events/index.js";
import type {
  AppServerPlanState,
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
  AppServerThreadGoalState,
} from "../../agent-server/codex/app-server-event-store.js";
import {
  AgentTaskStore,
  cloneAgentTaskState,
} from "../task/agent-task-store.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import type {
  AgentTaskEventPayload,
} from "../task/task-events.js";
import type {
  AgentTaskState,
} from "../task/types.js";
import type { AgentRegistry } from "../core/agent-registry.js";

export interface AgentTaskBackendOptions {
  registry: AgentRegistry;
  taskStore: AgentTaskStore;
  eventBus: EventBus;
  logger: {
    info(input: unknown): void;
    warn(input: unknown): void;
  };
}

export class AgentTaskBackend {
  private readonly registry: AgentRegistry;
  private readonly taskStore: AgentTaskStore;
  private readonly eventBus: EventBus;
  private readonly logger: AgentTaskBackendOptions["logger"];

  constructor(options: AgentTaskBackendOptions) {
    this.registry = options.registry;
    this.taskStore = options.taskStore;
    this.eventBus = options.eventBus;
    this.logger = options.logger;
    this.subscribeToTaskEvents();
  }

  stopAgentTask(target: string, reason = "任务已被 Coordinator 停止。"): AgentTaskState {
    const resolved = this.resolveTaskTarget(target);
    const task = resolved.agent.runner.stopTask(resolved.taskId, reason);
    return task;
  }

  getAgentTask(taskId: string): AgentTaskState {
    const task = this.taskStore.getTask(taskId);
    if (!task) throw new Error(`Unknown agent task: ${taskId}`);
    return task;
  }

  hasRunningAgentTasks(): boolean {
    if (this.taskStore.hasRunningTasks()) {
      return true;
    }
    return this.registry.listAgents().some((agent) => agent.runner.hasRunningTasks());
  }

  hasOpenAgentTasks(): boolean {
    return this.taskStore.hasOpenTasks();
  }

  hasWaitingHumanInputTasks(): boolean {
    return this.taskStore.hasWaitingHumanInputTasks();
  }

  handleAppServerTimelineEntry(
    agent: ScoutAgent,
    entry: AppServerTimelineEntry,
    resolver: AgentTaskTimelineResolver,
  ): void {
    const activeTask = this.taskStore.findActiveTaskForAgent(agent.agentId);
    switch (entry.stream) {
      case "item": {
        if (entry.kind !== "item_started" && entry.kind !== "item_completed") return;
        const resolved = resolver(entry);
        if (resolved.progressItem) {
          this.applyProgressUpdate(agent, activeTask, entry, resolved.progressItem);
        }
        return;
      }
      case "plan": {
        if (entry.kind !== "plan_updated" || !activeTask) return;
        const resolved = resolver(entry);
        if (resolved.plan) {
          this.applyPlanUpdate(activeTask, resolved.plan, entry);
        }
        return;
      }
      case "state": {
        if (entry.kind === "goal_updated") {
          if (!activeTask) return;
          const resolved = resolver(entry);
          if (resolved.goal) {
            this.applyGoalUpdate(activeTask, resolved.goal, entry);
          }
          return;
        }
        if (entry.kind === "token_usage_updated") {
          const resolved = resolver(entry);
          this.applyTokenUsageUpdate(agent, activeTask, entry, resolved.tokenUsage);
        }
      }
    }
  }

  resolveAgentTask(agent: ScoutAgent, taskId: string | undefined, context: string): AgentTaskState {
    if (taskId) {
      const task = this.taskStore.getTask(taskId);
      if (!task) throw new Error(`Unknown agent task: ${taskId}`);
      if (task.agentId !== agent.agentId) {
        throw new Error(`Task ${taskId} does not belong to agent ${agent.agentId}.`);
      }
      return task;
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
    this.eventBus.subscribe(AgentEvents.task, (event) => {
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
    const stored = this.taskStore.updateTask(updated.taskId, () => updated);
    this.logger.info({
      module: "agent.task",
      event: "goal_updated",
      agentId: stored.agentId,
      taskId: stored.taskId,
      data: {
        status: stored.status,
        role: stored.role,
        description: stored.description,
        seq: entry.seq,
        goal,
      },
    });
    this.eventBus.publish(AgentEvents.task.goalUpdated, {
      task: cloneAgentTaskState(stored),
      data: {
        seq: entry.seq,
        goal,
      },
    } satisfies AgentTaskEventPayload);
    return stored;
  }

  private applyPlanUpdate(
    task: AgentTaskState,
    plan: AppServerPlanState,
    entry: AppServerTimelineEntry,
  ): AgentTaskState {
    const updated: AgentTaskState = {
      ...task,
      plan,
      planRecords: [...(task.planRecords ?? []), plan],
      updatedAt: new Date().toISOString(),
    };
    const stored = this.taskStore.updateTask(updated.taskId, () => updated);
    this.logger.info({
      module: "agent.task",
      event: "plan_updated",
      agentId: stored.agentId,
      taskId: stored.taskId,
      data: {
        status: stored.status,
        role: stored.role,
        description: stored.description,
        seq: entry.seq,
        plan,
      },
    });
    this.eventBus.publish(AgentEvents.task.planUpdated, {
      task: cloneAgentTaskState(stored),
      data: {
        seq: entry.seq,
        plan,
      },
    } satisfies AgentTaskEventPayload);
    return stored;
  }

  private applyProgressUpdate(
    agent: ScoutAgent,
    activeTask: AgentTaskState | undefined,
    entry: AppServerTimelineEntry,
    progressItem: NonNullable<AppServerResolvedTimelineEntry["progressItem"]>,
  ): void {
    this.logger.info({
      module: "agent.progress",
      event: "progress_item",
      agentId: agent.agentId,
      taskId: activeTask?.taskId,
      data: {
        seq: entry.seq,
        threadId: progressItem.threadId,
        turnId: progressItem.turnId,
        itemId: progressItem.itemId,
        type: progressItem.type,
        status: progressItem.status,
        label: progressItem.label,
        detail: progressItem.detail,
        updatedAt: progressItem.updatedAt,
      },
    });
  }

  private applyTokenUsageUpdate(
    agent: ScoutAgent,
    activeTask: AgentTaskState | undefined,
    entry: AppServerTimelineEntry,
    tokenUsage: AppServerResolvedTimelineEntry["tokenUsage"],
  ): void {
    this.logger.info({
      module: "agent.state",
      event: "thread_token_usage_updated",
      agentId: agent.agentId,
      taskId: activeTask?.taskId,
      data: {
        seq: entry.seq,
        threadId: entry.threadId,
        turnId: entry.turnId,
        tokenUsage,
      },
    });
  }

}

export type AgentTaskTimelineResolver = (
  entry: AppServerTimelineEntry,
) => AppServerResolvedTimelineEntry;

export function cloneTask(task: AgentTaskState): AgentTaskState {
  return cloneAgentTaskState(task);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asLogObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}
