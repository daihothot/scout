import type {
  AppServerTimelineEntry,
} from "../../agent-server/codex/app-server-event-store.js";
import { AgentActivityBackend } from "./agent-activity-backend.js";
import { AgentTaskBackend } from "./agent-task-backend.js";
import { AgentToolBackend } from "./agent-tool-backend.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";

export class AgentBackend {
  readonly registry: RunScope["agentRegistry"];
  readonly activity: AgentActivityBackend;
  readonly task: AgentTaskBackend;
  readonly tool: AgentToolBackend;
  readonly domain: RunScope["domain"];
  private readonly scope: RunScope;
  private unsubscribeDynamicTools?: () => void;
  private unsubscribeTimeline?: () => void;

  constructor() {
    const scope = currentRunScope();
    this.scope = scope;
    this.domain = scope.domain;
    this.registry = scope.agentRegistry;
    this.activity = new AgentActivityBackend();
    this.task = new AgentTaskBackend();
    this.tool = new AgentToolBackend({
      taskBackend: this.task,
    });
  }

  start(): void {
    if (this.unsubscribeDynamicTools || this.unsubscribeTimeline) return;
    const unsubscribeDynamicTools = this.scope.appServer.setDynamicToolCallHandler((input) =>
      this.tool.handleDynamicToolCall(input)
    );
    try {
      const unsubscribeTimeline = this.scope.appServer.onTimeline((entry) =>
        this.handleAppServerTimelineEntry(entry)
      );
      this.unsubscribeDynamicTools = unsubscribeDynamicTools;
      this.unsubscribeTimeline = unsubscribeTimeline;
    } catch (error) {
      unsubscribeDynamicTools();
      throw error;
    }
  }

  stop(): void {
    const unsubscribeTimeline = this.unsubscribeTimeline;
    const unsubscribeDynamicTools = this.unsubscribeDynamicTools;
    this.unsubscribeTimeline = undefined;
    this.unsubscribeDynamicTools = undefined;
    try {
      unsubscribeTimeline?.();
    } finally {
      unsubscribeDynamicTools?.();
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
    this.task.handleAppServerTimelineEntry(agent, entry, (timelineEntry) =>
      this.scope.appServer.resolveTimelineEntry(timelineEntry)
    );
    this.activity.handleAppServerTimelineEntry(
      agent,
      entry,
      () => this.scope.appServer.resolveTimelineEntry(entry),
    );
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
