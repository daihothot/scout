import { join } from "node:path";
import type {
  AppServerProgressItem,
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
} from "../../agent-server/codex/app-server-event-store.js";
import { writeJsonFile } from "../../core/fs.js";
import { AgentTaskBackend, type AgentTaskTimelineProjection } from "./agent-task-backend.js";
import { AgentToolBackend } from "./agent-tool-backend.js";
import type {
  AgentBackendOptions,
  ScoutAgentLedger,
} from "./types.js";
import type { AgentTaskState } from "../task/types.js";
import type { ScoutAgent } from "../core/scout-agent.js";

export type {
  AgentBackendOptions,
  AssignBackendAgentTaskInput,
  ScoutAgentLedger,
} from "./types.js";

export class AgentBackend {
  readonly registry: AgentBackendOptions["registry"];
  readonly task: AgentTaskBackend;
  readonly tool: AgentToolBackend;
  readonly domain: AgentBackendOptions["domain"];
  private readonly runId: string;
  private readonly ledgerRoot: string;
  private readonly options: AgentBackendOptions;

  constructor(options: AgentBackendOptions) {
    this.runId = options.runId;
    this.ledgerRoot = options.ledgerRoot;
    this.options = options;
    this.domain = options.domain;
    this.registry = options.registry;
    this.task = new AgentTaskBackend({
      registry: this.registry,
      taskStore: options.taskStore,
      eventBus: options.eventBus,
      agentProvider: options.agentProvider,
      logger: options.logger,
      onTaskChanged: () => this.flushLedger(),
    });
    options.lifecycle.setAgentStartedHandler(() => this.flushLedger());
    this.tool = new AgentToolBackend({
      registry: this.registry,
      taskBackend: this.task,
      domain: options.domain,
      logger: options.logger,
    });
    options.appServer.setDynamicToolCallHandler((input) => this.tool.handleDynamicToolCall(input));
    options.appServer.onTimeline((entry, resolved) => this.handleAppServerTimelineEntry(entry, resolved));
  }

  getLedger(): ScoutAgentLedger {
    return {
      ledgerVersion: 1,
      runId: this.runId,
      agents: this.options.lifecycle.listStartedAgents(),
      threadPreflights: this.options.lifecycle.listThreadPreflights(),
      tasks: this.options.taskStore.listTasks(),
    };
  }

  flushLedger(): void {
    writeJsonFile(join(this.ledgerRoot, "agent-ledger.json"), this.getLedger());
  }

  private handleAppServerTimelineEntry(
    entry: AppServerTimelineEntry,
    resolved: AppServerResolvedTimelineEntry,
  ): void {
    if (!entry.threadId) {
      this.handleUnboundAppServerTimelineEntry(entry, resolved);
      return;
    }
    const agent = this.registry.resolveAgentByThreadId(entry.threadId);
    if (!agent) {
      this.handleUnboundAppServerTimelineEntry(entry, resolved);
      return;
    }
    this.consumeAppServerTimelineEntry(agent, entry, resolved);
  }

  private consumeAppServerTimelineEntry(
    agent: ScoutAgent,
    entry: AppServerTimelineEntry,
    resolved: AppServerResolvedTimelineEntry,
  ): void {
    const activeTask = this.findActiveTask(agent);
    this.options.logger.info({
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
    const projection = this.task.consumeAppServerTimelineEntry(agent, entry, resolved);
    if (projection) this.publishTimelineProjection(projection);
  }

  private handleUnboundAppServerTimelineEntry(
    entry: AppServerTimelineEntry,
    resolved: AppServerResolvedTimelineEntry,
  ): void {
    this.options.logger.info({
      module: `agent.app_server.${entry.stream}`,
      event: entry.kind,
      data: {
        runId: this.runId,
        timeline: entry,
        resolved,
      },
    });
  }

  private findActiveTask(agent: ScoutAgent): AgentTaskState | undefined {
    return this.options.taskStore.findActiveTaskForAgent(agent.agentId);
  }

  private publishTimelineProjection(projection: AgentTaskTimelineProjection): void {
    switch (projection.kind) {
      case "progress":
        this.publishAppServerProgress(projection.agent, projection.entry, projection.progressItem);
        return;
      case "goal_updated":
        void this.options.interactionPort?.disclose({
          level: "info",
          source: `agent.goal.${projection.agent.agentId}`,
          message: "Agent goal updated.",
          data: {
            runId: this.runId,
            seq: projection.entry.seq,
            agentId: projection.agent.agentId,
            taskId: projection.task.taskId,
            goal: projection.goal,
          },
        });
        return;
      case "plan_updated":
        void this.options.interactionPort?.disclose({
          level: "info",
          source: `agent.plan.${projection.agent.agentId}`,
          message: "Agent plan updated.",
          data: {
            runId: this.runId,
            seq: projection.entry.seq,
            agentId: projection.agent.agentId,
            taskId: projection.task.taskId,
            plan: projection.plan,
          },
        });
        return;
      case "token_usage_updated":
        this.options.logger.info({
          module: "agent.state",
          event: "thread_token_usage_updated",
          agentId: projection.agent.agentId,
          taskId: projection.activeTask?.taskId,
          data: {
            runId: this.runId,
            seq: projection.entry.seq,
            threadId: projection.entry.threadId,
            turnId: projection.entry.turnId,
            tokenUsage: projection.tokenUsage,
          },
        });
        return;
    }
  }

  private publishAppServerProgress(
    agent: ScoutAgent,
    entry: AppServerTimelineEntry,
    progressItem: AppServerProgressItem,
  ): void {
    const activeTask = this.options.taskStore.findActiveTaskForAgent(agent.agentId);
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
    this.options.logger.info({
      module: "agent.progress",
      event: "progress_item",
      agentId: agent.agentId,
      taskId: activeTask?.taskId,
      data: progressEvent,
    });
    void this.options.interactionPort?.publishProgress(progressEvent).catch((error) => {
      this.options.logger.warn({
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
}
