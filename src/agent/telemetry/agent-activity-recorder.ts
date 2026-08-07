import type {
  UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import type {
  AgentActivity,
  AgentNativeSubagentActivity,
  AgentTurnActivity,
} from "../activity/activity-event.js";
import { AgentEvents } from "../events/index.js";

/** Records app-server activity projections into per-agent run logs. */
export class AgentActivityRecorder {
  private readonly activityLoggers = new Map<string, Logger>();
  private readonly nativeSubagentLoggers = new Map<string, Logger>();
  private unsubscribers: UnsubscribeEventHandler[] = [];

  start(): void {
    if (this.unsubscribers.length > 0) return;
    const eventBus = currentRunScope().eventBus;
    this.unsubscribers.push(
      eventBus.subscribe<AgentActivity>(
        AgentEvents.activity.observed,
        (event) => this.recordActivity(event.payload),
      ),
      eventBus.subscribe<AgentTurnActivity>(
        AgentEvents.activity.turnObserved,
        (event) => this.recordTurn(event.payload),
      ),
      eventBus.subscribe<AgentNativeSubagentActivity>(
        AgentEvents.activity.nativeSubagentObserved,
        (event) => this.recordNativeSubagentActivity(event.payload),
      ),
    );
  }

  stop(): void {
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
    this.activityLoggers.clear();
    this.nativeSubagentLoggers.clear();
  }

  private recordActivity(activity: AgentActivity): void {
    if (activity.type === "dynamicToolCall") return;
    if (activity.type === "collabAgentToolCall" || activity.type === "subAgentActivity") return;
    if (activity.type === "reasoning" && activity.status !== "completed") return;
    this.loggerFor(activity.agentId).info({
      module: "agent.activity",
      event: AgentEvents.activity.observed.routeKey,
      agentId: activity.agentId,
      taskId: activity.taskId,
      data: activity,
    });
  }

  private recordNativeSubagentActivity(activity: AgentNativeSubagentActivity): void {
    this.nativeSubagentLoggerFor(activity.agentId).info({
      module: "agent.subagent",
      event: AgentEvents.activity.nativeSubagentObserved.routeKey,
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
    const scope = currentRunScope();
    const agent = scope.agentRegistry.resolveAgent(agentId);
    const logger = new Logger({
      runId: scope.runId,
      logsRoot: agent.mount.logsRoot,
      fileName: "activity.log",
    });
    this.activityLoggers.set(agentId, logger);
    return logger;
  }

  private nativeSubagentLoggerFor(agentId: string): Logger {
    const existing = this.nativeSubagentLoggers.get(agentId);
    if (existing) return existing;
    const scope = currentRunScope();
    const agent = scope.agentRegistry.resolveAgent(agentId);
    const logger = new Logger({
      runId: scope.runId,
      logsRoot: agent.mount.logsRoot,
      fileName: "subagent.log",
    });
    this.nativeSubagentLoggers.set(agentId, logger);
    return logger;
  }
}
