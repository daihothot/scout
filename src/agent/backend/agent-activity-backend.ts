import type {
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
} from "../../agent-server/codex/app-server-event-store.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import type { AgentActivity } from "../activity/activity-event.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import { AgentEvents } from "../events/index.js";

export class AgentActivityBackend {
  private readonly scope: RunScope;

  constructor() {
    this.scope = currentRunScope();
  }

  handleAppServerTimelineEntry(
    agent: ScoutAgent,
    entry: AppServerTimelineEntry,
    resolve: () => AppServerResolvedTimelineEntry,
  ): void {
    if (entry.stream !== "item" || !entry.threadId) return;
    if (
      entry.kind !== "item_started"
      && entry.kind !== "item_completed"
      && entry.kind !== "reasoning_summary_part_added"
      && entry.kind !== "reasoning_summary_delta"
    ) return;

    const activeTask = this.scope.taskStore.findActiveTaskForAgent(agent.agentId);
    const resolved = resolve();
    const progressItem = resolved.progressItem;
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
        status: progressItem.status,
        label: progressItem.label,
        detail: progressItem.detail,
        updatedAt: progressItem.updatedAt,
      }
      : resolved.item && resolved.item.type !== "agentMessage" && resolved.item.type !== "userMessage"
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
          detail: resolved.item.type === "reasoning" ? reasoningSummary(resolved.item.summary) : undefined,
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
