import type {
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
} from "../../agent-server/codex/app-server-event-store.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import type {
  AgentActivity,
  AgentNativeSubagentActivity,
  AgentTurnActivity,
} from "../activity/activity-event.js";
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
    if (!entry.threadId) return;
    if (
      entry.stream === "lifecycle"
      && (entry.kind === "turn_started" || entry.kind === "turn_completed")
      && entry.turnId
    ) {
      const activeTask = this.scope.taskStore.findActiveTaskForAgent(agent.agentId);
      const turn = entry.kind === "turn_completed" ? resolve().turn : undefined;
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
    const resolved = resolve();
    if (resolved.item?.type === "collabAgentToolCall") {
      this.scope.eventBus.publish(AgentEvents.activity.nativeSubagentObserved, {
        seq: entry.seq,
        agentId: agent.agentId,
        role: agent.role,
        taskId: activeTask?.taskId,
        threadId: entry.threadId,
        turnId: entry.turnId,
        itemId: resolved.item.id,
        type: resolved.item.type,
        tool: resolved.item.tool,
        status: resolved.item.status,
        senderThreadId: resolved.item.senderThreadId,
        receiverThreadIds: [...resolved.item.receiverThreadIds],
        prompt: resolved.item.prompt,
        model: resolved.item.model,
        reasoningEffort: resolved.item.reasoningEffort,
        agentsStates: structuredClone(resolved.item.agentsStates),
        updatedAt: entry.receivedAt,
      } satisfies AgentNativeSubagentActivity);
    } else if (resolved.item?.type === "subAgentActivity") {
      this.scope.eventBus.publish(AgentEvents.activity.nativeSubagentObserved, {
        seq: entry.seq,
        agentId: agent.agentId,
        role: agent.role,
        taskId: activeTask?.taskId,
        threadId: entry.threadId,
        turnId: entry.turnId,
        itemId: resolved.item.id,
        type: resolved.item.type,
        kind: resolved.item.kind,
        agentThreadId: resolved.item.agentThreadId,
        agentPath: resolved.item.agentPath,
        updatedAt: entry.receivedAt,
      } satisfies AgentNativeSubagentActivity);
    }
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
          detail: resolved.item.type === "reasoning"
            ? reasoningSummary(resolved.item.summary)
            : resolved.item.type === "subAgentActivity"
              ? `${resolved.item.kind}: ${resolved.item.agentThreadId}`
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
    case "collabAgentToolCall":
      return `Native subagent ${item.tool}`;
    case "subAgentActivity":
      return "Native subagent activity";
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
