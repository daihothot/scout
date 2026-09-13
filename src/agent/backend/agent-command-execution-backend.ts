import type {
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
} from "../../agent-server/codex/app-server-event-store.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import { AgentEvents } from "../events/index.js";
import type { AgentCommandExecutionObservedEvent } from "../command-execution/command-execution-events.js";

/** Publishes one generic command fact for each completed shell command. */
export class AgentCommandExecutionBackend {
  private readonly scope: RunScope = currentRunScope();

  handleAppServerTimelineEntry(
    agent: ScoutAgent,
    entry: AppServerTimelineEntry,
    resolved: AppServerResolvedTimelineEntry,
  ): void {
    const item = resolved.item;
    if (entry.stream !== "item" || entry.kind !== "item_completed") return;
    if (!item || item.type !== "commandExecution") return;
    if (!entry.threadId) return;

    const activeTask = this.scope.taskStore.findActiveTaskForAgent(agent.agentId);
    const observedAt = entry.receivedAt;
    this.scope.eventBus.publish(AgentEvents.commandExecution.observed, {
      sourceSeq: entry.seq,
      agentId: agent.agentId,
      role: agent.role,
      ...(activeTask ? { taskId: activeTask.taskId } : {}),
      threadId: entry.threadId,
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
      itemId: item.id,
      command: item.command,
      ...(item.cwd ? { cwd: item.cwd } : {}),
      status: item.status,
      ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
      ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
      observedAt,
    } satisfies AgentCommandExecutionObservedEvent, { occurredAt: observedAt });
  }
}
