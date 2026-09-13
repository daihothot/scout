import type {
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
} from "../../agent-server/codex/app-server-event-store.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import { AgentEvents } from "../events/index.js";
import type { AgentNativeSubagentEvent } from "../subagent/subagent-events.js";

/** Projects native multi-agent timeline items into subagent facts. */
export class AgentSubagentBackend {
  private readonly scope: RunScope;

  constructor() {
    this.scope = currentRunScope();
  }

  handleAppServerTimelineEntry(
    agent: ScoutAgent,
    entry: AppServerTimelineEntry,
    resolved: AppServerResolvedTimelineEntry,
  ): void {
    const threadId = entry.threadId;
    if (!threadId || entry.stream !== "item") return;
    if (
      entry.kind !== "item_started"
      && entry.kind !== "item_completed"
      && entry.kind !== "reasoning_summary_part_added"
      && entry.kind !== "reasoning_summary_delta"
    ) return;

    const item = resolved.item;
    if (item?.type === "collabAgentToolCall") {
      const activeTask = this.scope.taskStore.findActiveTaskForAgent(agent.agentId);
      this.scope.eventBus.publish(AgentEvents.subagent.observed, {
        seq: entry.seq,
        agentId: agent.agentId,
        role: agent.role,
        taskId: activeTask?.taskId,
        threadId,
        turnId: entry.turnId,
        itemId: item.id,
        type: item.type,
        tool: item.tool,
        status: item.status,
        senderThreadId: item.senderThreadId,
        receiverThreadIds: [...item.receiverThreadIds],
        prompt: item.prompt,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
        agentsStates: structuredClone(item.agentsStates),
        updatedAt: entry.receivedAt,
      } satisfies AgentNativeSubagentEvent);
      return;
    }
    if (item?.type !== "subAgentActivity") return;
    const activeTask = this.scope.taskStore.findActiveTaskForAgent(agent.agentId);
    this.scope.eventBus.publish(AgentEvents.subagent.observed, {
      seq: entry.seq,
      agentId: agent.agentId,
      role: agent.role,
      taskId: activeTask?.taskId,
      threadId,
      turnId: entry.turnId,
      itemId: item.id,
      type: item.type,
      kind: item.kind,
      agentThreadId: item.agentThreadId,
      agentPath: item.agentPath,
      updatedAt: entry.receivedAt,
    } satisfies AgentNativeSubagentEvent);
  }
}
