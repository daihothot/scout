import type { AppServerTimelineEntry } from "../../agent-server/codex/app-server-event-store.js";
import { AgentActivityBackend } from "./agent-activity-backend.js";
import { AgentStepBackend } from "./agent-step-backend.js";
import { AgentToolCallBackend } from "./agent-tool-call-backend.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";

/**
 * Owns the run-scoped app-server subscriptions and composes the Tool Call and
 * Step backend trees. Agent construction and lifecycle orchestration are
 * intentionally left to the surrounding run stages.
 */
export class AgentBackend {
  readonly registry: RunScope["agentRegistry"];
  readonly activity: AgentActivityBackend;
  readonly step: AgentStepBackend;
  readonly toolCall: AgentToolCallBackend;
  readonly domain: RunScope["domain"];
  private readonly scope: RunScope;
  private unsubscribeTimeline?: () => void;

  constructor() {
    const scope = currentRunScope();
    this.scope = scope;
    this.domain = scope.domain;
    this.registry = scope.agentRegistry;
    this.activity = new AgentActivityBackend();
    this.step = new AgentStepBackend();
    this.toolCall = new AgentToolCallBackend({
      taskBackend: this.step.task,
    });
  }

  start(): void {
    if (this.unsubscribeTimeline) return;
    let unsubscribeTimeline: (() => void) | undefined;
    try {
      this.toolCall.start();
      unsubscribeTimeline = this.scope.appServer.onTimeline((entry) =>
        this.handleAppServerTimelineEntry(entry)
      );
      this.unsubscribeTimeline = unsubscribeTimeline;
    } catch (error) {
      unsubscribeTimeline?.();
      this.toolCall.stop();
      throw error;
    }
  }

  stop(): void {
    const unsubscribeTimeline = this.unsubscribeTimeline;
    this.unsubscribeTimeline = undefined;
    try {
      unsubscribeTimeline?.();
    } finally {
      this.toolCall.stop();
    }
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
