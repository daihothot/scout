import { join } from "node:path";
import { writeJsonFile } from "../../core/fs.js";
import type {
  AppServerPlanState,
  AppServerProgressItem,
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
  AppServerThreadGoalState,
} from "../../agent-server/codex/app-server-event-store.js";
import {
  runtimeMessageQueueManager,
  type EnqueueRuntimeCommandInput,
  type RuntimeMessageQueueManager,
  type RuntimeQueuedCommand,
} from "../../core/queue/message-queue.js";
import type { RuntimeInteractionPort } from "../../interaction/index.js";
import {
  renderTaskNotificationXml,
  renderUserInputRequestNotification,
} from "../../interaction/protocol/index.js";
import type { ScoutAgent } from "../scout-agent.js";
import { AgentTaskStateEvents } from "../task/types.js";
import type {
  AgentTaskState,
  AgentTaskStateEvent,
  SendAgentMessageInput,
} from "../task/types.js";
import type { AgentRegistry } from "./agent-registry.js";
import type {
  AssignBackendAgentTaskInput,
  ScoutAgentLedger,
} from "./types.js";

export interface AgentTaskBackendOptions {
  runId: string;
  ledgerRoot: string;
  registry: AgentRegistry;
  logger: {
    info(input: unknown): void;
    warn(input: unknown): void;
  };
  messageQueue?: RuntimeMessageQueueManager;
  interactionPort?: RuntimeInteractionPort;
}

export class AgentTaskBackend {
  private readonly runId: string;
  private readonly ledgerRoot: string;
  private readonly registry: AgentRegistry;
  private readonly logger: AgentTaskBackendOptions["logger"];
  private readonly messageQueue: RuntimeMessageQueueManager;
  private readonly interactionPort?: RuntimeInteractionPort;
  private readonly tasks = new Map<string, AgentTaskState>();
  private taskSequence = 0;

  constructor(options: AgentTaskBackendOptions) {
    this.runId = options.runId;
    this.ledgerRoot = options.ledgerRoot;
    this.registry = options.registry;
    this.logger = options.logger;
    this.messageQueue = options.messageQueue ?? runtimeMessageQueueManager;
    this.interactionPort = options.interactionPort;
  }

  assignAgentTask(input: AssignBackendAgentTaskInput): AgentTaskState {
    const agent = input.agentId
      ? this.registry.resolveAgent(input.agentId)
      : this.registry.getOrCreateAgentForRole(input.subagentType);
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

  getAgentTask(taskId: string): AgentTaskState {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown agent task: ${taskId}`);
    return cloneTask(task);
  }

  drainCoordinatorCommands(): RuntimeQueuedCommand[] {
    return this.messageQueue.drain();
  }

  hasQueuedCoordinatorCommands(): boolean {
    return this.messageQueue.snapshot().length > 0;
  }

  hasRunningAgentTasks(): boolean {
    if ([...this.tasks.values()].some((task) => task.status === "queued" || task.status === "running")) {
      return true;
    }
    return this.registry.listAgents().some((agent) => agent.task.hasRunningTasks());
  }

  enqueueCoordinatorCommand(input: EnqueueRuntimeCommandInput): RuntimeQueuedCommand {
    return this.messageQueue.enqueue(input);
  }

  syncTaskSnapshot(task: AgentTaskState): void {
    this.tasks.set(task.taskId, cloneTask(task));
    this.writeLedger();
  }

  applyTaskStateChange(event: AgentTaskStateEvent, task: AgentTaskState, data?: unknown): void {
    this.tasks.set(task.taskId, cloneTask(task));
    this.logger.info({
      module: "agent.task",
      event,
      agentId: task.agentId,
      taskId: task.taskId,
      data: {
        status: task.status,
        role: task.role,
        description: task.description,
        ...asLogObject(data),
      },
    });
    this.writeLedger();
  }

  handleUserInputRequested(task: AgentTaskState): void {
    this.tasks.set(task.taskId, cloneTask(task));
    this.enqueueUserInputRequest(task);
    this.writeLedger();
  }

  handleTaskTerminal(task: AgentTaskState): void {
    this.tasks.set(task.taskId, cloneTask(task));
    this.enqueueTaskNotification(task);
    this.writeLedger();
  }

  async consumeAppServerTimelineEntry(
    agent: ScoutAgent,
    entry: AppServerTimelineEntry,
    resolved: AppServerResolvedTimelineEntry,
  ): Promise<void> {
    const activeTask = this.findActiveTask(agent);
    this.logger.info({
      module: `agent.app_server.${entry.stream}`,
      event: entry.kind,
      agentId: agent.agentId,
      taskId: activeTask?.taskId,
      data: {
        runId: this.runId,
        timeline: entry,
        resolved,
      },
    });
    if (
      entry.stream === "item"
      && (entry.kind === "item_started" || entry.kind === "item_completed")
      && resolved.progressItem
    ) {
      this.publishAppServerProgress(agent, entry, resolved.progressItem);
      return;
    }
    if (entry.stream === "plan" && resolved.plan) {
      await this.applyPlanUpdate(agent, resolved.plan, entry);
      return;
    }
    if (entry.stream === "state" && entry.kind === "goal_updated" && resolved.goal) {
      await this.applyGoalUpdate(agent, resolved.goal, entry);
      return;
    }
    if (entry.stream === "state" && entry.kind === "token_usage_updated") {
      this.logger.info({
        module: "agent.state",
        event: "thread_token_usage_updated",
        agentId: agent.agentId,
        taskId: activeTask?.taskId,
        data: {
          runId: this.runId,
          seq: entry.seq,
          threadId: entry.threadId,
          turnId: entry.turnId,
          tokenUsage: resolved.tokenUsage,
        },
      });
    }
  }

  handleUnboundAppServerTimelineEntry(
    entry: AppServerTimelineEntry,
    resolved: AppServerResolvedTimelineEntry,
  ): void {
    this.logger.info({
      module: `agent.app_server.${entry.stream}`,
      event: entry.kind,
      data: {
        runId: this.runId,
        timeline: entry,
        resolved,
      },
    });
  }

  resolveAgentTask(agent: ScoutAgent, taskId: string | undefined, context: string): AgentTaskState {
    if (taskId) {
      const task = agent.task.getTaskSnapshot(taskId);
      if (!task) throw new Error(`Task ${taskId} does not belong to agent ${agent.agentId}.`);
      return task;
    }
    const active = agent.task.listTasks().find((task) => task.status === "running" || task.status === "queued" || task.status === "waiting_for_input");
    if (!active) throw new Error(`Agent ${agent.agentId} has no active task for ${context}.`);
    return active;
  }

  getLedger(): ScoutAgentLedger {
    return {
      ledgerVersion: 1,
      runId: this.runId,
      agents: this.registry.listStartedAgents(),
      threadPreflights: this.registry.listThreadPreflights(),
      tasks: [...this.tasks.values()].map(cloneTask),
    };
  }

  flushLedger(): void {
    this.writeLedger();
  }

  private findActiveTask(agent: ScoutAgent): AgentTaskState | undefined {
    const live = agent.task.listTasks().find((task) =>
      task.status === "running" || task.status === "queued" || task.status === "waiting_for_input"
    );
    if (live) {
      const recorded = this.tasks.get(live.taskId);
      return recorded ? { ...live, ...recorded } : live;
    }
    return [...this.tasks.values()].find((task) =>
      task.agentId === agent.agentId
      && (task.status === "running" || task.status === "queued" || task.status === "waiting_for_input")
    );
  }

  private async applyGoalUpdate(
    agent: ScoutAgent,
    goal: AppServerThreadGoalState,
    entry?: AppServerTimelineEntry,
  ): Promise<void> {
    const task = this.findActiveTask(agent);
    if (!task) return;
    const updated: AgentTaskState = {
      ...task,
      goal,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(updated.taskId, cloneTask(updated));
    this.logger.info({
      module: "agent.task",
      event: AgentTaskStateEvents.GoalUpdated,
      agentId: updated.agentId,
      taskId: updated.taskId,
      data: {
        status: updated.status,
        role: updated.role,
        description: updated.description,
        seq: entry?.seq,
        goal,
      },
    });
    this.writeLedger();
    await this.interactionPort?.disclose({
      level: "info",
      source: `agent.goal.${agent.agentId}`,
      message: "Agent goal updated.",
      data: {
        runId: this.runId,
        seq: entry?.seq,
        agentId: agent.agentId,
        taskId: updated.taskId,
        goal,
      },
    });
  }

  private async applyPlanUpdate(
    agent: ScoutAgent,
    plan: AppServerPlanState,
    entry?: AppServerTimelineEntry,
  ): Promise<void> {
    const task = this.findActiveTask(agent);
    if (!task) return;
    const updated: AgentTaskState = {
      ...task,
      plan,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(updated.taskId, cloneTask(updated));
    this.logger.info({
      module: "agent.task",
      event: AgentTaskStateEvents.PlanUpdated,
      agentId: updated.agentId,
      taskId: updated.taskId,
      data: {
        status: updated.status,
        role: updated.role,
        description: updated.description,
        seq: entry?.seq,
        plan,
      },
    });
    this.writeLedger();
    await this.interactionPort?.disclose({
      level: "info",
      source: `agent.plan.${agent.agentId}`,
      message: "Agent plan updated.",
      data: {
        runId: this.runId,
        seq: entry?.seq,
        agentId: agent.agentId,
        taskId: updated.taskId,
        plan,
      },
    });
  }

  private publishAppServerProgress(
    agent: ScoutAgent,
    entry: AppServerTimelineEntry,
    progressItem: AppServerProgressItem,
  ): void {
    const activeTask = agent.task.listTasks().find((task) =>
      task.status === "running" || task.status === "queued" || task.status === "waiting_for_input"
    );
    const progressEvent = {
      source: "app-server",
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
        timeline: entry,
        item: progressItem.item,
      },
    };
    this.logger.info({
      module: "agent.progress",
      event: "progress_item",
      agentId: agent.agentId,
      taskId: activeTask?.taskId,
      data: progressEvent,
    });
    void this.interactionPort?.publishProgress(progressEvent).catch((error) => {
      this.logger.warn({
        module: "interaction",
        event: "progress_publish_failed",
        agentId: agent.agentId,
        taskId: activeTask?.taskId,
        data: {
          progressItemId: progressItem.itemId,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        },
      });
    });
  }

  private resolveTaskTarget(target: string): { agent: ScoutAgent; taskId: string } {
    const task = this.tasks.get(target);
    if (task) {
      return {
        agent: this.registry.resolveAgent(task.agentId),
        taskId: task.taskId,
      };
    }
    const agent = this.registry.resolveAgent(target);
    const active = agent.task.listTasks().find((item) => item.status === "running" || item.status === "queued" || item.status === "waiting_for_input");
    if (!active) {
      throw new Error(`Agent ${agent.agentId} has no active task.`);
    }
    return {
      agent,
      taskId: active.taskId,
    };
  }

  private enqueueTaskNotification(task: AgentTaskState): void {
    this.messageQueue.enqueue({
      type: "task_notification",
      priority: "later",
      sourceTaskId: task.taskId,
      payload: renderTaskNotificationXml(task),
    });
    this.logger.info({
      module: "agent.task",
      event: AgentTaskStateEvents.NotificationEnqueued,
      agentId: task.agentId,
      taskId: task.taskId,
      data: {
        status: task.status,
        role: task.role,
        description: task.description,
      },
    });
  }

  private enqueueUserInputRequest(task: AgentTaskState): void {
    if (!task.userInputRequest) return;
    this.messageQueue.enqueue({
      type: "user_input",
      priority: "next",
      sourceTaskId: task.taskId,
      payload: renderUserInputRequestNotification({
        task,
        request: task.userInputRequest,
      }),
    });
    this.logger.info({
      module: "agent.task",
      event: AgentTaskStateEvents.UserInputRequestEnqueued,
      agentId: task.agentId,
      taskId: task.taskId,
      data: {
        status: task.status,
        role: task.role,
        description: task.description,
        requestId: task.userInputRequest.requestId,
        kind: task.userInputRequest.kind,
        question: task.userInputRequest.question,
      },
    });
  }

  private nextTaskId(): string {
    this.taskSequence += 1;
    return `agent-task-${String(this.taskSequence).padStart(4, "0")}`;
  }

  private writeLedger(): void {
    writeJsonFile(join(this.ledgerRoot, "agent-ledger.json"), this.getLedger());
  }
}

export function cloneTask(task: AgentTaskState): AgentTaskState {
  return {
    ...task,
    usage: task.usage ? { ...task.usage } : undefined,
    thread: task.thread ? { ...task.thread } : undefined,
    userInputRequest: task.userInputRequest ? {
      ...task.userInputRequest,
      options: task.userInputRequest.options ? [...task.userInputRequest.options] : undefined,
    } : undefined,
    outcome: task.outcome ? {
      ...task.outcome,
      artifactRefs: [...task.outcome.artifactRefs],
      evidenceRefs: [...task.outcome.evidenceRefs],
    } : undefined,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asLogObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}
