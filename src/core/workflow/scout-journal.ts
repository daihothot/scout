import { scoutJournalPaths } from "../path.js";
import { AgentEvents } from "../../agent/events/index.js";
import { RunEvents } from "../../run/events/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { SystemEvents } from "../../system/events/index.js";
import type { EventType, ScoutEvent } from "../events/index.js";
import {
  Journal,
  JournalWriter,
} from "../journal/index.js";
import type { JournalEvent } from "../journal/index.js";

const eventTypes: readonly EventType[] = [
  RunEvents.run.created,
  RunEvents.runtime.attached,
  RunEvents.runtime.detached,
  RunEvents.runtime.interrupted,
  SystemEvents.interaction.userMessageSubmitted,
  AgentEvents.coordinator.messageProduced,
  AgentEvents.thread.started,
  AgentEvents.thread.restarted,
  AgentEvents.message.queued,
  AgentEvents.message.consumed,
  AgentEvents.turn.started,
  AgentEvents.turn.completed,
  AgentEvents.turn.interrupted,
  AgentEvents.task.assigned,
  AgentEvents.task.stepStarted,
  AgentEvents.task.stepCompleted,
  AgentEvents.task.stepInterrupted,
  AgentEvents.task.dispositionRecorded,
  AgentEvents.task.outcomeSubmitted,
  AgentEvents.task.released,
  AgentEvents.task.failed,
  AgentEvents.task.stopped,
  AgentEvents.step.started,
  AgentEvents.step.completed,
  AgentEvents.step.interrupted,
  AgentEvents.step.failed,
  AgentEvents.step.planUpdated,
  AgentEvents.step.toolCallReferenced,
  AgentEvents.step.humanInputReferenced,
  AgentEvents.toolCall.observed,
  AgentEvents.humanInput.requested,
  AgentEvents.humanInput.responded,
];

interface PreparedScoutJournal {
  readonly journal: Journal;
  readonly journalRoot: string;
  readonly checkpointSeq: number;
}

/** Owns the active Workflow's scout.journal and its shared event writer. */
export class ScoutJournal {
  private active?: Journal;
  private activeRoot?: string;
  private writer?: JournalWriter;
  private runId?: string;
  private readonly prepared = new Set<Journal>();
  private readonly previous = new Set<Journal>();
  private readonly closeFailures = new Map<Journal, unknown>();
  private failurePublished = false;

  create(journalRoot: string, baseline?: readonly ScoutEvent[]): void {
    if (this.active) throw new Error("Workflow scout.journal is already available.");
    const scope = currentRunScope();
    this.runId = scope.runId;
    if (baseline !== undefined) {
      const prepared = this.prepare(journalRoot, baseline);
      this.setActive(prepared.journal, journalRoot);
      this.prepared.delete(prepared.journal);
      return;
    }
    this.setActive(
      Journal.create(this.location(journalRoot)),
      journalRoot,
    );
  }

  open(journalRoot: string): void {
    const scope = currentRunScope();
    this.runId = scope.runId;
    this.setActive(
      Journal.open(this.location(journalRoot)),
      journalRoot,
    );
  }

  start(): void {
    if (this.writer) return;
    this.requireActive();
    const scope = currentRunScope();
    this.failurePublished = false;
    const writer = new JournalWriter({
      eventBus: scope.eventBus,
      eventTypes,
      journal: () => this.requireActive(),
      onSuccess: () => {
        this.failurePublished = false;
      },
      onFailure: (failure) => {
        if (this.failurePublished) return;
        this.failurePublished = true;
        const payload = {
          failedEventId: failure.event.id,
          failedEventKey: failure.event.key.routeKey,
          error: failure.error instanceof Error
            ? failure.error.stack ?? failure.error.message
            : String(failure.error),
          failedAt: failure.failedAt,
        };
        scope.eventBus.publish(RunEvents.journal.writeFailed, payload, {
          occurredAt: failure.failedAt,
        });
        try {
          scope.logger.warn({
            module: "workflow.journal",
            event: "scout_journal_write_failed",
            message: `Failed to append ${payload.failedEventKey} to scout.journal after 2 attempts.`,
            data: { ...payload, journalId: failure.journalId },
          });
        } catch {
          // The runtime logger may share the same unavailable filesystem.
        }
      },
    });
    writer.start();
    this.writer = writer;
  }

  stop(): void {
    this.writer?.stop();
    this.writer = undefined;
    const failures: unknown[] = [];
    for (const journals of [this.prepared, this.previous]) {
      for (const journal of journals) {
        try {
          this.closeJournal(journal);
          journals.delete(journal);
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (this.active) {
      try {
        this.closeJournal(this.active);
        this.active = undefined;
        this.activeRoot = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to close Workflow scout.journal resources.");
    }
    this.runId = undefined;
  }

  prepare(journalRoot: string, baseline: readonly ScoutEvent[]): PreparedScoutJournal {
    this.runId = currentRunScope().runId;
    const journal = Journal.create(this.location(journalRoot));
    this.prepared.add(journal);
    try {
      journal.replaceAll(baseline);
      return {
        journal,
        journalRoot,
        checkpointSeq: journal.lastSeq,
      };
    } catch (error) {
      try {
        this.closeJournal(journal);
        this.prepared.delete(journal);
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "Failed to prepare and close Workflow scout.journal.",
        );
      }
      throw error;
    }
  }

  activate(prepared: PreparedScoutJournal): void {
    if (!this.prepared.has(prepared.journal)) {
      throw new Error("Cannot activate an unknown prepared scout.journal.");
    }
    if (this.closeFailures.has(prepared.journal)) {
      throw this.closeFailures.get(prepared.journal);
    }
    const previous = this.active;
    this.prepared.delete(prepared.journal);
    this.active = prepared.journal;
    this.activeRoot = prepared.journalRoot;
    if (previous) this.previous.add(previous);
  }

  /** Releases retired journals only after the Workflow switch has committed. */
  releasePrevious(): void {
    const failures: unknown[] = [];
    for (const journal of this.previous) {
      try {
        this.closeJournal(journal);
        this.previous.delete(journal);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to release previous Workflow scout.journal.");
    }
  }

  discard(prepared: PreparedScoutJournal): void {
    if (!this.prepared.has(prepared.journal)) return;
    this.closeJournal(prepared.journal);
    this.prepared.delete(prepared.journal);
  }

  /** Commits a Workflow fact before its event is broadcast to observers. */
  write(event: ScoutEvent): JournalEvent {
    if (!this.writer) throw new Error("Workflow scout.journal writer is not started.");
    return this.writer.write(event);
  }

  get hasPreparedJournals(): boolean {
    return this.prepared.size > 0;
  }

  readAll(): JournalEvent[] {
    return this.requireActive().readAll();
  }

  get lastSeq(): number {
    return this.requireActive().lastSeq;
  }

  get journalRoot(): string {
    if (!this.activeRoot) throw new Error("Workflow scout.journal root is unavailable.");
    return this.activeRoot;
  }

  get path(): string {
    return this.requireActive().path;
  }

  get failed(): boolean {
    return this.requireActive().failed;
  }

  private setActive(journal: Journal, journalRoot: string): void {
    if (this.active) throw new Error("Workflow scout.journal is already available.");
    this.active = journal;
    this.activeRoot = journalRoot;
  }

  private requireActive(): Journal {
    if (!this.active) throw new Error("Workflow scout.journal is unavailable.");
    return this.active;
  }

  private closeJournal(journal: Journal): void {
    if (this.closeFailures.has(journal)) throw this.closeFailures.get(journal);
    try {
      journal.close();
    } catch (error) {
      // Journal.close marks itself closed before releasing its lock. A later
      // no-op close must not be mistaken for confirmed resource release.
      this.closeFailures.set(journal, error);
      throw error;
    }
  }

  private location(journalRoot: string) {
    if (!this.runId) throw new Error("Workflow scout.journal Run is unavailable.");
    return {
      journalId: `${this.runId}:workflow:scout`,
      ...scoutJournalPaths(journalRoot),
    };
  }
}
