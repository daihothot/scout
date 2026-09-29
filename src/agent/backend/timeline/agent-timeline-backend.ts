import type { AppServerTimelineEntry } from "../../../agent-server/codex/app-server-event-store.js";
import { AgentTimelineActivityBackend } from "./agent-timeline-activity-backend.js";
import { AgentTimelineStepBackend } from "./agent-timeline-step-backend.js";
import { AgentTimelineToolCallBackend } from "./agent-timeline-tool-call-backend.js";
import { AgentTimelineCommandExecutionBackend } from "./agent-timeline-command-execution-backend.js";
import { AgentTimelineSubagentBackend } from "./agent-timeline-subagent-backend.js";
import type { ScoutAgent } from "../../core/scout-agent.js";
import { currentRunScope, type RunScope } from "../../../run/run-scope.js";

/**
 * Owns the run-scoped Timeline subscription and dispatches observations to
 * their projections. Tool execution and request responses use separate backends.
 */
export class AgentTimelineBackend {
  readonly registry: RunScope["agentRegistry"];
  readonly activity: AgentTimelineActivityBackend;
  readonly subagent: AgentTimelineSubagentBackend;
  readonly commandExecution: AgentTimelineCommandExecutionBackend;
  readonly step: AgentTimelineStepBackend;
  readonly toolCall: AgentTimelineToolCallBackend;
  private readonly scope: RunScope;
  private unsubscribeTimeline?: () => void;

  constructor() {
    const scope = currentRunScope();
    this.scope = scope;
    this.registry = scope.agentRegistry;
    this.activity = new AgentTimelineActivityBackend();
    this.subagent = new AgentTimelineSubagentBackend();
    this.commandExecution = new AgentTimelineCommandExecutionBackend();
    this.step = new AgentTimelineStepBackend();
    this.toolCall = new AgentTimelineToolCallBackend();
  }

  start(): void {
    if (this.unsubscribeTimeline) return;
    this.unsubscribeTimeline = this.scope.appServer.onTimeline((entry) =>
      this.handleAppServerTimelineEntry(entry)
    );
  }

  stop(): void {
    const unsubscribeTimeline = this.unsubscribeTimeline;
    this.unsubscribeTimeline = undefined;
    unsubscribeTimeline?.();
  }

  private handleAppServerTimelineEntry(entry: AppServerTimelineEntry): void {
    if (!entry.threadId) {
      this.handleUnboundAppServerTimelineEntry(entry);
      return;
    }
    const agent = this.registry.resolveAgentByThreadId(entry.threadId);
    if (!agent) {
      this.handleUnboundAppServerTimelineEntry(entry);
      return;
    }
    this.handleAppServerTimelineEntryForAgent(agent, entry);
  }

  private handleAppServerTimelineEntryForAgent(
    agent: ScoutAgent,
    entry: AppServerTimelineEntry,
  ): void {
    this.logAppServerHealthEvent(entry, agent);
    const resolved = this.scope.appServer.resolveTimelineEntry(entry);
    this.step.handleAppServerTimelineEntry(agent, entry, resolved);
    this.toolCall.handleAppServerTimelineEntry(agent, entry, resolved);
    this.commandExecution.handleAppServerTimelineEntry(agent, entry, resolved);
    this.subagent.handleAppServerTimelineEntry(agent, entry, resolved);
    this.activity.handleAppServerTimelineEntry(agent, entry, resolved);
  }

  private handleUnboundAppServerTimelineEntry(entry: AppServerTimelineEntry): void {
    this.logAppServerHealthEvent(entry);
  }

  private logAppServerHealthEvent(entry: AppServerTimelineEntry, agent?: ScoutAgent): void {
    if (entry.kind !== "disconnect") return;
    const activeTask = agent
      ? this.scope.taskStore.findActiveTaskForAgent(agent.agentId)
      : undefined;
    this.scope.logger.warn({
      module: "runtime.app_server",
      event: "disconnected",
      message: agent
        ? `Codex app-server disconnected while serving agent ${agent.agentId}.`
        : "Codex app-server disconnected before its event could be bound to an agent.",
      agentId: agent?.agentId,
      taskId: activeTask?.taskId,
      data: {
        runId: this.scope.runId,
        seq: entry.seq,
        threadId: entry.threadId,
        turnId: entry.turnId,
        receivedAt: entry.receivedAt,
      },
    });
  }

}
