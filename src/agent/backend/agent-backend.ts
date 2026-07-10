import type { AppServerTimelineEntry } from "../../agent-server/codex/app-server-event-store.js";
import { AgentTaskBackend } from "./agent-task-backend.js";
import { AgentToolBackend } from "./agent-tool-backend.js";
import type { AgentBackendOptions } from "./types.js";
import type { AgentTaskState } from "../task/types.js";
import type { ScoutAgent } from "../core/scout-agent.js";

export type {
  AgentBackendOptions,
} from "./types.js";

export class AgentBackend {
  readonly registry: AgentBackendOptions["registry"];
  readonly task: AgentTaskBackend;
  readonly tool: AgentToolBackend;
  readonly domain: AgentBackendOptions["domain"];
  private readonly runId: string;
  private readonly options: AgentBackendOptions;

  constructor(options: AgentBackendOptions) {
    this.runId = options.runId;
    this.options = options;
    this.domain = options.domain;
    this.registry = options.registry;
    this.task = new AgentTaskBackend({
      registry: this.registry,
      taskStore: options.taskStore,
      eventBus: options.eventBus,
      logger: options.logger,
    });
    this.tool = new AgentToolBackend({
      registry: this.registry,
      taskStore: options.taskStore,
      taskBackend: this.task,
      agentProvider: options.agentProvider,
      domain: options.domain,
      logger: options.logger,
    });
    options.appServer.setDynamicToolCallHandler((input) => this.tool.handleDynamicToolCall(input));
    options.appServer.onTimeline((entry) => this.handleAppServerTimelineEntry(entry));
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
      this.options.appServer.resolveTimelineEntry(timelineEntry)
    );
  }

  private handleUnboundAppServerTimelineEntry(entry: AppServerTimelineEntry): void {
    this.logAppServerHealthEvent(entry);
  }

  private logAppServerHealthEvent(entry: AppServerTimelineEntry, agent?: ScoutAgent): void {
    if (entry.kind !== "disconnect") return;
    const activeTask = agent ? this.findActiveTask(agent) : undefined;
    this.options.logger.warn({
      target: "runtime",
      module: "runtime.app_server",
      event: "disconnected",
      agentId: agent?.agentId,
      taskId: activeTask?.taskId,
      data: {
        runId: this.runId,
        seq: entry.seq,
        threadId: entry.threadId,
        turnId: entry.turnId,
        receivedAt: entry.receivedAt,
      },
    });
  }

  private findActiveTask(agent: ScoutAgent): AgentTaskState | undefined {
    return this.options.taskStore.findActiveTaskForAgent(agent.agentId);
  }
}
