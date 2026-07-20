import type {
  EventBus,
  UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import type {
  AgentActivity,
  AgentTurnActivity,
} from "../activity/activity-event.js";
import type { AgentRegistry } from "../core/agent-registry.js";
import { AgentEvents } from "../events/index.js";

export interface AgentActivityRecorderOptions {
  runId: string;
  eventBus: EventBus;
  registry: AgentRegistry;
}

export class AgentActivityRecorder {
  private readonly runId: string;
  private readonly eventBus: EventBus;
  private readonly registry: AgentRegistry;
  private readonly activityLoggers = new Map<string, Logger>();
  private unsubscribers: UnsubscribeEventHandler[] = [];

  constructor(options: AgentActivityRecorderOptions) {
    this.runId = options.runId;
    this.eventBus = options.eventBus;
    this.registry = options.registry;
  }

  start(): void {
    if (this.unsubscribers.length > 0) return;
    this.unsubscribers.push(
      this.eventBus.subscribe<AgentActivity>(
        AgentEvents.activity.observed,
        (event) => this.recordActivity(event.payload),
      ),
      this.eventBus.subscribe<AgentTurnActivity>(
        AgentEvents.activity.turnObserved,
        (event) => this.recordTurn(event.payload),
      ),
    );
  }

  stop(): void {
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
    this.activityLoggers.clear();
  }

  private recordActivity(activity: AgentActivity): void {
    if (activity.type === "dynamicToolCall") return;
    if (activity.type === "reasoning" && activity.status !== "completed") return;
    this.loggerFor(activity.agentId).info({
      module: "agent.activity",
      event: AgentEvents.activity.observed.routeKey,
      agentId: activity.agentId,
      taskId: activity.taskId,
      data: activity,
    });
  }

  private recordTurn(activity: AgentTurnActivity): void {
    this.loggerFor(activity.agentId).info({
      module: "agent.activity",
      event: AgentEvents.activity.turnObserved.routeKey,
      agentId: activity.agentId,
      taskId: activity.taskId,
      data: activity,
    });
  }

  private loggerFor(agentId: string): Logger {
    const existing = this.activityLoggers.get(agentId);
    if (existing) return existing;
    const agent = this.registry.resolveAgent(agentId);
    const logger = new Logger({
      runId: this.runId,
      logsRoot: agent.mount.logsRoot,
      fileName: "activity.log",
    });
    this.activityLoggers.set(agentId, logger);
    return logger;
  }
}
