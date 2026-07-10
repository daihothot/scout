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
import type { RuntimeProgressEvent } from "../../interaction/port.js";
import { SystemEvents } from "../../system/events/index.js";
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
        if (
          entry.kind !== "item_started"
          && entry.kind !== "item_completed"
          && entry.kind !== "reasoning_summary_part_added"
          && entry.kind !== "reasoning_summary_delta"
        ) return;
        const resolved = resolver(entry);
        const progress = resolveRuntimeProgressEvent(agent, activeTask, entry, resolved);
        if (progress) {
          this.applyProgressUpdate(entry, progress);
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
        return;
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
    const { task } = event.payload;
    this.logger.info({
      target: "runtime",
      module: "agent.task",
      event: event.key.routeKey,
      agentId: task.agentId,
      taskId: task.taskId,
      data: taskEventLogData(event, task),
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
    entry: AppServerTimelineEntry,
    progress: RuntimeProgressEvent,
  ): void {
    if (shouldLogProgress(entry, progress)) {
      this.logger.info({
        module: "agent.item",
        event: progress.type === "reasoning" ? "reasoning_completed" : entry.kind,
        agentId: progress.agentId,
        taskId: progress.taskId,
        data: {
          seq: entry.seq,
          threadId: progress.threadId,
          turnId: progress.turnId,
          itemId: progress.itemId,
          type: progress.type,
          status: progress.status,
          label: progress.label,
          summary: progress.type === "reasoning" ? progress.detail : undefined,
          updatedAt: progress.updatedAt,
        },
      });
    }
    this.eventBus.publish(SystemEvents.interaction.progressRequested, progress);
  }

}

function resolveRuntimeProgressEvent(
  agent: ScoutAgent,
  activeTask: AgentTaskState | undefined,
  entry: AppServerTimelineEntry,
  resolved: AppServerResolvedTimelineEntry,
): RuntimeProgressEvent | undefined {
  const progressItem = resolved.progressItem;
  if (progressItem) {
    return {
      source: "agent.app_server.item",
      seq: entry.seq,
      agentId: agent.agentId,
      taskId: activeTask?.taskId,
      threadId: progressItem.threadId,
      turnId: progressItem.turnId,
      itemId: progressItem.itemId,
      type: progressItem.type,
      status: progressItem.status,
      label: progressItem.label,
      detail: progressItem.detail,
      updatedAt: progressItem.updatedAt,
      data: {
        role: agent.role,
      },
    };
  }

  const item = resolved.item;
  if (!item) return undefined;
  if (item.type === "agentMessage" || item.type === "userMessage") return undefined;
  return {
    source: "agent.app_server.item",
    seq: entry.seq,
    agentId: agent.agentId,
    taskId: activeTask?.taskId,
    threadId: entry.threadId,
    turnId: entry.turnId,
    itemId: item.id,
    type: item.type,
    status: item.status ?? (entry.kind === "item_completed" ? "completed" : "inProgress"),
    label: itemLabel(item),
    detail: item.type === "reasoning" ? reasoningSummary(item.summary) : undefined,
    updatedAt: entry.receivedAt,
    data: {
      role: agent.role,
    },
  };
}

function itemLabel(item: NonNullable<AppServerResolvedTimelineEntry["item"]>): string {
  switch (item.type) {
    case "reasoning":
      return "Reasoning";
    case "fileChange":
      return "File changes";
    case "unknown":
      return `Unknown item (${item.rawType})`;
    default:
      return item.type;
  }
}

function reasoningSummary(summary: string[] | undefined): string | undefined {
  const text = (summary ?? []).map((part) => part.trim()).filter(Boolean).join("\n").trim();
  return text.length > 0 ? text : undefined;
}

function shouldLogProgress(
  entry: AppServerTimelineEntry,
  progress: RuntimeProgressEvent,
): boolean {
  if (progress.type === "reasoning") return entry.kind === "item_completed";
  if (progress.type === "dynamicToolCall") return false;
  return entry.kind === "item_started" || entry.kind === "item_completed";
}

function taskEventLogData(
  event: ScoutEvent<AgentTaskEventPayload>,
  task: AgentTaskState,
): Record<string, unknown> {
  const base = {
    status: task.status,
    role: task.role,
  };
  if (AgentEvents.task.assigned.is(event)) {
    return {
      ...base,
      description: task.description,
      backgrounded: task.isBackgrounded,
    };
  }
  if (AgentEvents.task.threadAttached.is(event)) {
    return {
      ...base,
      threadId: task.thread?.threadId,
    };
  }
  if (AgentEvents.task.planUpdated.is(event)) {
    return {
      ...base,
      plan: task.plan ? {
        turnId: task.plan.turnId,
        explanation: task.plan.explanation,
        steps: task.plan.steps.map((step) => ({
          step: step.step,
          status: step.status,
        })),
      } : undefined,
    };
  }
  if (AgentEvents.task.goalUpdated.is(event)) {
    return {
      ...base,
      goal: task.goal ? {
        objective: task.goal.objective,
        status: task.goal.status,
      } : undefined,
    };
  }
  if (AgentEvents.task.stepStarted.is(event)
    || AgentEvents.task.stepCompleted.is(event)
    || AgentEvents.task.stepOutput.is(event)) {
    const step = task.steps?.at(-1);
    return {
      ...base,
      step: step ? {
        stepId: step.stepId,
        turnId: step.turnId,
        status: step.status,
        durationMs: step.durationMs,
        toolCallCount: step.toolCalls.length,
      } : undefined,
    };
  }
  if (AgentEvents.task.humanInputRequested.is(event)) {
    const request = task.steps?.at(-1)?.humanInputRequest;
    return {
      ...base,
      request: request ? {
        requestId: request.requestId,
        kind: request.kind,
        status: request.status,
      } : undefined,
    };
  }
  if (AgentEvents.task.humanInputResponded.is(event)) {
    const response = task.steps?.at(-1)?.humanInputResponse;
    return {
      ...base,
      response: response ? {
        requestId: response.requestId,
      } : undefined,
    };
  }
  if (AgentEvents.task.terminal.is(event)) {
    return {
      ...base,
      durationMs: elapsedMs(task.startedAt, task.finishedAt),
      outcome: task.outcome,
      error: task.error,
    };
  }
  return base;
}

function elapsedMs(startedAt: string | undefined, finishedAt: string | undefined): number | undefined {
  if (!startedAt || !finishedAt) return undefined;
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return undefined;
  return Math.max(0, finished - started);
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
