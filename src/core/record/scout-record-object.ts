import { randomUUID } from "node:crypto";
import { scoutJournalPaths } from "../io/index.js";
import { AgentEvents } from "../../agent/events/index.js";
import { CoordinatorAgent } from "../../agent/roles/coordinator-agent.js";
import { RunEvents } from "../../run/events/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { SystemEvents } from "../../system/events/index.js";
import { RecordableObject, type RecordEvent, type RecordWriteFailure } from "./recordable-object.js";
import { decodeScoutRecords, type ScoutRecord } from "./scout-record.js";
import { WorkflowEvents } from "../workflow/workflow-events.js";

/** Owns Scout facts for the active Workflow; file mechanics are a Core recording detail. */
export class ScoutRecordObject extends RecordableObject<ScoutRecord> {
  readonly eventTypes = [
    RunEvents.run.created, RunEvents.runtime.attached, RunEvents.runtime.detached, RunEvents.runtime.interrupted,
    SystemEvents.interaction.userMessageSubmitted, AgentEvents.coordinator.messageProduced,
    AgentEvents.thread.started, AgentEvents.thread.restarted,
    AgentEvents.message.queued, AgentEvents.message.consumed,
    AgentEvents.turn.started, AgentEvents.turn.completed, AgentEvents.turn.interrupted,
    AgentEvents.task.assigned, AgentEvents.task.stepStarted, AgentEvents.task.stepCompleted,
    AgentEvents.task.stepInterrupted, AgentEvents.task.dispositionRecorded, AgentEvents.task.outcomeSubmitted,
    AgentEvents.task.released, AgentEvents.task.failed, AgentEvents.task.stopped,
    AgentEvents.step.started, AgentEvents.step.completed, AgentEvents.step.interrupted, AgentEvents.step.failed,
    AgentEvents.step.planUpdated, AgentEvents.step.toolCallReferenced, AgentEvents.step.humanInputReferenced,
    AgentEvents.toolCall.observed, AgentEvents.humanInput.requested, AgentEvents.humanInput.responded,
  ] as const;
  private failurePublished = false;

  constructor() { super("Workflow scout"); }

  static override readFile(path: string): ScoutRecord[] { return decodeScoutRecords(super.readFile(path)); }

  protected decode(records: readonly RecordEvent[]): ScoutRecord[] { return decodeScoutRecords(records); }

  protected location(journalRoot: string) {
    return { journalId: `${currentRunScope().runId}:workflow:scout`, ...scoutJournalPaths(journalRoot) };
  }

  protected override baselineEvents() {
    const scope = currentRunScope();
    const manifest = scope.manifestStore.read();
    const graph = scope.workflow.graph.initialSnapshot();
    const at = new Date().toISOString();
    return [
      { id: randomUUID(), key: RunEvents.run.created,
        payload: { runId: manifest.runId, scoutRoot: scope.scoutRoot, createdAt: manifest.createdAt }, occurredAt: manifest.createdAt },
      { id: randomUUID(), key: WorkflowEvents.workflow.initialized,
        payload: { state: graph, initializedAt: at }, occurredAt: at },
      ...scope.agentRegistry.listAgents().map((agent) => {
        const thread = agent.threadSnapshot;
        if (!thread || thread.status !== "active") throw new Error("Agent " + agent.agentId + " has no active Thread.");
        return { id: randomUUID(), key: AgentEvents.thread.started, payload: thread, occurredAt: at };
      }),
      ...scope.agentRegistry.listAgents().flatMap((agent) => agent instanceof CoordinatorAgent
        ? agent.pendingWorkflowInputs().flatMap(({ event, delivery }) => [
          event,
          { id: randomUUID(), key: AgentEvents.message.queued, payload: delivery, occurredAt: delivery.queuedAt },
        ]) : []),
    ];
  }

  override stop(): void {
    super.stop();
    this.release();
  }

  protected override onWriteSuccess(): void { this.failurePublished = false; }

  protected override onWriteFailure(failure: RecordWriteFailure): void {
    if (this.failurePublished) return;
    this.failurePublished = true;
    const scope = currentRunScope();
    const payload = {
      failedEventId: failure.event.id, failedEventKey: failure.event.key.routeKey,
      error: failure.error instanceof Error ? failure.error.stack ?? failure.error.message : String(failure.error),
      failedAt: failure.failedAt,
    };
    scope.eventBus.publish(RunEvents.journal.writeFailed, payload, { occurredAt: failure.failedAt });
    try {
      scope.logger.warn({
        module: "workflow.journal", event: "scout_journal_write_failed",
        message: `Failed to append ${payload.failedEventKey} to scout.journal after 2 attempts.`,
        data: { ...payload, journalId: failure.recordId },
      });
    } catch { /* Failure disclosure must not depend on the same unavailable filesystem. */ }
  }
}
