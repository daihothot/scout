import {
  ScoutAgentEventTypes,
  type ScoutAgentEvent,
} from "../scout-agent.js";
import type {
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
} from "../../agent-server/codex/app-server-event-store.js";
import { AgentRegistry } from "./agent-registry.js";
import { AgentTaskBackend } from "./agent-task-backend.js";
import { AgentToolBackend } from "./agent-tool-backend.js";
import type {
  AgentBackendOptions,
} from "./types.js";

export type {
  AgentBackendOptions,
  AssignBackendAgentTaskInput,
  CoordinatorSyntheticOutput,
  ScoutAgentLedger,
} from "./types.js";

export class AgentBackend {
  readonly registry: AgentRegistry;
  readonly task: AgentTaskBackend;
  readonly tool: AgentToolBackend;

  constructor(options: AgentBackendOptions) {
    this.registry = new AgentRegistry({
      options,
      agentMounts: options.agentMounts,
      agentAssetCommits: options.agentAssetCommits,
      onAgentEvent: (event) => this.handleAgentEvent(event),
      onAgentStarted: () => this.task.flushLedger(),
    });
    this.task = new AgentTaskBackend({
      runId: options.runId,
      ledgerRoot: options.ledgerRoot,
      registry: this.registry,
      logger: options.logger,
      messageQueue: options.messageQueue,
      interactionPort: options.interactionPort,
    });
    this.tool = new AgentToolBackend({
      runId: options.runId,
      registry: this.registry,
      taskBackend: this.task,
      logger: options.logger,
      interactionPort: options.interactionPort,
    });
    options.appServer.setDynamicToolCallHandler((input) => this.tool.handleDynamicToolCall(input));
    options.appServer.onTimeline((entry, resolved) => this.handleAppServerTimelineEntry(entry, resolved));
  }

  private handleAgentEvent(event: ScoutAgentEvent): void {
    if (event.type === ScoutAgentEventTypes.TaskStateChanged) {
      this.task.applyTaskStateChange(event.event, event.task, event.data);
      return;
    }
    if (event.type === ScoutAgentEventTypes.UserInputRequested) {
      this.task.handleUserInputRequested(event.task);
      return;
    }
    this.task.handleTaskTerminal(event.task);
  }

  private handleAppServerTimelineEntry(
    entry: AppServerTimelineEntry,
    resolved: AppServerResolvedTimelineEntry,
  ): void {
    if (!entry.threadId) {
      this.task.handleUnboundAppServerTimelineEntry(entry, resolved);
      return;
    }
    const agent = this.registry.resolveAgentByThreadId(entry.threadId);
    if (!agent) {
      this.task.handleUnboundAppServerTimelineEntry(entry, resolved);
      return;
    }
    void this.task.consumeAppServerTimelineEntry(agent, entry, resolved);
  }
}
