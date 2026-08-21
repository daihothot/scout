import type { UnsubscribeEventHandler } from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { AgentEvents } from "../events/index.js";
import type { AgentToolCallState, AgentToolCallStatus } from "../tool-call/types.js";

interface ToolCallLogSummary extends AgentToolCallState {
  firstObservedAt: string;
  lastObservedAt: string;
  observationCount: number;
  statusHistory: AgentToolCallStatus[];
}

/** Keeps the complete event/journal fact stream while aggregating one log record per Tool Call. */
export class AgentToolCallRecorder {
  private readonly loggers = new Map<string, Logger>();
  private readonly summaries = new Map<string, ToolCallLogSummary>();
  private readonly recordedCallIds = new Set<string>();
  private unsubscribe?: UnsubscribeEventHandler;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = currentRunScope().eventBus.subscribe(AgentEvents.toolCall.observed, (event) => {
      if (!AgentEvents.toolCall.observed.is(event)) return;
      this.record(event.payload);
    });
  }

  stop(): void {
    for (const summary of this.summaries.values()) {
      if (!this.recordedCallIds.has(summary.toolCallId)) {
        this.writeSummary(summary);
      }
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
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
    let logger = this.loggers.get(summary.agentId);
    if (!logger) {
      const agent = scope.agentRegistry.resolveAgent(summary.agentId);
      logger = new Logger({
        runId: scope.runId,
        logsRoot: agent.mount.logsRoot,
        fileName: "tool-calls.log",
      });
      this.loggers.set(summary.agentId, logger);
    }
    logger.info({
      module: "agent.tool_call",
      event: "agent.tool_call.summary",
      agentId: summary.agentId,
      taskId: summary.taskId,
      data: summary,
    });
    this.recordedCallIds.add(summary.toolCallId);
  }
}

function isTerminalStatus(status: AgentToolCallStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
