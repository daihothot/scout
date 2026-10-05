import { EventSubscriptionPriorities, type UnsubscribeEventHandler } from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { AgentEvents } from "../events/index.js";
import type { AgentToolCallState, AgentToolCallStatus } from "../tool-call/types.js";
import { agentTelemetryLogsRoot } from "../../core/io/index.js";

interface ToolCallLogSummary extends AgentToolCallState {
  logsRoot: string;
  firstObservedAt: string;
  lastObservedAt: string;
  observationCount: number;
  statusHistory: AgentToolCallStatus[];
}

/** Keeps the complete event/journal fact stream while aggregating one log record per Tool Call. */
export class AgentToolCallRecorder {
  private readonly loggers = new Map<string, Logger>();
  private readonly summaries = new Map<string, ToolCallLogSummary>();
  private readonly recordedCallIds = new Map<string, string>();
  private unsubscribe?: UnsubscribeEventHandler;
  private unsubscribeTurnStarted?: UnsubscribeEventHandler;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = currentRunScope().eventBus.subscribe(AgentEvents.toolCall.observed, (event) => {
      if (!AgentEvents.toolCall.observed.is(event)) return;
      this.record(event.payload);
    });
    // Reclaim before asynchronous Turn observers can let new tool observations overtake this boundary.
    this.unsubscribeTurnStarted = currentRunScope().eventBus.subscribe(AgentEvents.turn.started, (event) => {
      if (!AgentEvents.turn.started.is(event)) return;
      for (const [callId, agentId] of this.recordedCallIds) {
        if (agentId === event.payload.agentId) this.recordedCallIds.delete(callId);
      }
    }, { priority: EventSubscriptionPriorities.Critical });
  }

  stop(): void {
    for (const summary of this.summaries.values()) {
      if (!this.recordedCallIds.has(summary.toolCallId)) {
        this.writeSummary(summary);
      }
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeTurnStarted?.();
    this.unsubscribeTurnStarted = undefined;
    this.loggers.clear();
    this.summaries.clear();
    this.recordedCallIds.clear();
  }

  private record(call: AgentToolCallState): void {
    if (this.recordedCallIds.has(call.toolCallId)) return;
    const existing = this.summaries.get(call.toolCallId);
    const summary: ToolCallLogSummary = existing
      ? {
        ...existing,
        ...call,
        firstObservedAt: existing.firstObservedAt,
        lastObservedAt: call.observedAt,
        observationCount: existing.observationCount + 1,
        statusHistory: existing.statusHistory.at(-1) === call.status
          ? existing.statusHistory
          : [...existing.statusHistory, call.status],
      }
      : {
        ...call,
        logsRoot: agentTelemetryLogsRoot(call.agentId),
        firstObservedAt: call.observedAt,
        lastObservedAt: call.observedAt,
        observationCount: 1,
        statusHistory: [call.status],
      };
    this.summaries.set(call.toolCallId, summary);
    if (isTerminalStatus(call.status)) {
      this.writeSummary(summary);
    }
  }

  private writeSummary(summary: ToolCallLogSummary): void {
    const scope = currentRunScope();
    let logger = this.loggers.get(summary.logsRoot);
    if (!logger) {
      logger = new Logger({
        runId: scope.runId,
        logsRoot: summary.logsRoot,
        fileName: "tool-calls.log",
      });
      this.loggers.set(summary.logsRoot, logger);
    }
    const { logsRoot: _logsRoot, ...data } = summary;
    logger.info({
      module: "agent.tool_call",
      event: "agent.tool_call.summary",
      agentId: summary.agentId,
      taskId: summary.taskId,
      data,
    });
    this.recordedCallIds.set(summary.toolCallId, summary.agentId);
    this.summaries.delete(summary.toolCallId);
  }
}

function isTerminalStatus(status: AgentToolCallStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
