import type {
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
} from "../../agent-server/codex/app-server-event-store.js";
import type { DynamicToolCallInput, DynamicToolCallResponse } from "../../agent-server/types.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import { AgentEvents } from "../events/index.js";
import type { AgentToolCallState } from "../tool-call/types.js";
import { AgentDynamicToolBackend } from "./agent-dynamic-tool-backend.js";
import { AgentTaskBackend } from "./agent-task-backend.js";

/**
 * Converts dynamic and MCP app-server items into independent Tool Call facts.
 * Dynamic tool command execution remains owned by AgentDynamicToolBackend; this class
 * only observes the provider timeline and records the resulting fact.
 */
export class AgentToolCallBackend {
  readonly dynamicTool: AgentDynamicToolBackend;
  private readonly scope: RunScope;

  constructor(input: {
    dynamicTool?: AgentDynamicToolBackend;
    taskBackend?: AgentTaskBackend;
  } = {}) {
    this.scope = currentRunScope();
    this.dynamicTool = input.dynamicTool ?? new AgentDynamicToolBackend({
      taskBackend: input.taskBackend ?? new AgentTaskBackend(),
    });
  }

  start(): void {
    this.dynamicTool.start();
  }

  stop(): void {
    this.dynamicTool.stop();
  }

  /** Forwards incoming dynamic-tool execution to the nested execution backend. */
  handleDynamicToolCall(input: DynamicToolCallInput): Promise<DynamicToolCallResponse> {
    return this.dynamicTool.handleDynamicToolCall(input);
  }

  handleAppServerTimelineEntry(
    agent: ScoutAgent,
    entry: AppServerTimelineEntry,
    resolved: AppServerResolvedTimelineEntry,
  ): void {
    if (entry.stream !== "item") return;
    if (
      entry.kind !== "item_started"
      && entry.kind !== "item_completed"
      && entry.kind !== "item_failed"
      && entry.kind !== "item_updated"
    ) return;
    const item = resolved.item;
    if (!item || (item.type !== "dynamicToolCall" && item.type !== "mcpToolCall")) return;
    if (!entry.threadId || !entry.turnId) return;
    const step = this.findStep(agent.agentId, entry.turnId);
    if (!step) return;
    const observedAt = entry.receivedAt;
    const state: AgentToolCallState = item.type === "dynamicToolCall"
      ? {
        toolCallId: item.id,
        kind: "dynamic",
        agentId: agent.agentId,
        taskId: step.taskId,
        stepId: step.stepId,
        threadId: entry.threadId,
        turnId: entry.turnId,
        itemId: item.id,
        namespace: item.namespace,
        tool: item.tool,
        arguments: item.arguments,
        status: item.status,
        success: item.success,
        contentItems: item.contentItems,
        sourceSeq: entry.seq,
        observedAt,
        finishedAt: isTerminalStatus(item.status) ? observedAt : undefined,
      }
      : {
        toolCallId: item.id,
        kind: "mcp",
        agentId: agent.agentId,
        taskId: step.taskId,
        stepId: step.stepId,
        threadId: entry.threadId,
        turnId: entry.turnId,
        itemId: item.id,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        status: item.status,
        success: item.status === "completed" ? true : item.status === "failed" ? false : null,
        result: item.result,
        error: item.error,
        sourceSeq: entry.seq,
        observedAt,
        finishedAt: isTerminalStatus(item.status) ? observedAt : undefined,
      };
    const stored = this.scope.toolCallStore.upsert(state);
    this.scope.eventBus.publish(AgentEvents.toolCall.observed, stored, { occurredAt: observedAt });
  }

  private findStep(agentId: string, turnId: string) {
    const candidates = this.scope.stepStore.list({ agentId });
    return candidates.find((step) => step.turnId === turnId)
      ?? candidates.find((step) => step.status === "running");
  }
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
