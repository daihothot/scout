import type {
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
} from "../../agent-server/codex/app-server-event-store.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import type {
  AgentActivity,
  AgentTurnActivity,
} from "../activity/activity-event.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import { AgentEvents } from "../events/index.js";

/**
 * Projects app-server timeline entries into activity and native subagent facts.
 * It owns no task state and only publishes observations after the caller has
 * resolved the relevant timeline item.
 */
export class AgentActivityBackend {
  private readonly scope: RunScope;

  constructor() {
    this.scope = currentRunScope();
  }

  handleAppServerTimelineEntry(
    agent: ScoutAgent,
    entry: AppServerTimelineEntry,
    resolved: AppServerResolvedTimelineEntry,
  ): void {
    if (!entry.threadId) return;
    if (
      entry.stream === "lifecycle"
      && (entry.kind === "turn_started" || entry.kind === "turn_completed")
      && entry.turnId
    ) {
      const activeTask = this.scope.taskStore.findActiveTaskForAgent(agent.agentId);
      const turn = entry.kind === "turn_completed" ? resolved.turn : undefined;
      this.scope.eventBus.publish(AgentEvents.activity.turnObserved, {
        seq: entry.seq,
        agentId: agent.agentId,
        role: agent.role,
        taskId: activeTask?.taskId,
        threadId: entry.threadId,
        turnId: entry.turnId,
        status: entry.kind === "turn_started" ? "inProgress" : turn?.status ?? "completed",
        updatedAt: entry.receivedAt,
      } satisfies AgentTurnActivity);
      return;
    }
    if (entry.stream !== "item") return;
    if (
      entry.kind !== "item_started"
      && entry.kind !== "item_completed"
      && entry.kind !== "reasoning_summary_part_added"
      && entry.kind !== "reasoning_summary_delta"
    ) return;

    const activeTask = this.scope.taskStore.findActiveTaskForAgent(agent.agentId);
    // Dynamic and MCP calls have their own Tool Call fact stream. Command
    // execution has its own complete fact stream and is not an Activity.
    const progressItem = resolved.progressItem
      && resolved.progressItem.type !== "dynamicToolCall"
      && resolved.progressItem.type !== "mcpToolCall"
      && resolved.progressItem.type !== "commandExecution"
      && resolved.progressItem.type !== "collabAgentToolCall"
      ? resolved.progressItem
      : undefined;
    let progressStatus = progressItem?.status;
    let progressDetail = progressItem?.detail;
    let progressLabel = progressItem?.label;
    const activity: AgentActivity | undefined = progressItem
      ? {
        seq: entry.seq,
        agentId: agent.agentId,
        role: agent.role,
        taskId: activeTask?.taskId,
        threadId: progressItem.threadId,
        turnId: progressItem.turnId,
        itemId: progressItem.itemId,
        type: progressItem.type,
        status: progressStatus ?? progressItem.status,
        label: progressLabel ?? progressItem.label,
        detail: progressDetail,
        updatedAt: progressItem.updatedAt,
      }
      : resolved.item
        && resolved.item.type !== "agentMessage"
        && resolved.item.type !== "userMessage"
        && resolved.item.type !== "dynamicToolCall"
        && resolved.item.type !== "mcpToolCall"
        && resolved.item.type !== "commandExecution"
        && resolved.item.type !== "collabAgentToolCall"
        && resolved.item.type !== "subAgentActivity"
        ? {
          seq: entry.seq,
          agentId: agent.agentId,
          role: agent.role,
          taskId: activeTask?.taskId,
          threadId: entry.threadId,
          turnId: entry.turnId,
          itemId: resolved.item.id,
          type: resolved.item.type,
          status: resolved.item.status ?? (entry.kind === "item_completed" ? "completed" : "inProgress"),
          label: itemLabel(resolved.item),
          detail: resolved.item.type === "reasoning"
            ? reasoningSummary(resolved.item.summary)
            : undefined,
          updatedAt: entry.receivedAt,
        }
        : undefined;

    if (activity) {
      this.scope.eventBus.publish(AgentEvents.activity.observed, activity);
    }
  }
}

function itemLabel(item: NonNullable<AppServerResolvedTimelineEntry["item"]>): string {
  switch (item.type) {
    case "reasoning":
      return "Reasoning";
    case "contextCompaction":
      return "Context compaction";
    case "fileChange":
      return "File changes";
    case "unknown":
      return `Unknown item (${item.rawType})`;
    default:
      return item.type;
  }
}

function reasoningSummary(summary: string[] | undefined): string | undefined {
  const text = (summary ?? []).map((part) => part.trim()).filter(Boolean).join("\n").trim();
  return text.length > 0 ? text : undefined;
}
