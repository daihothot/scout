import type {
  EventBus,
  UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import type { AgentActivity } from "../activity/activity-event.js";
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
  private unsubscribe?: UnsubscribeEventHandler;

  constructor(options: AgentActivityRecorderOptions) {
    this.runId = options.runId;
    this.eventBus = options.eventBus;
    this.registry = options.registry;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.eventBus.subscribe<AgentActivity>(
      AgentEvents.activity.observed,
      (event) => this.record(event.payload),
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.activityLoggers.clear();
  }

  private record(activity: AgentActivity): void {
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
