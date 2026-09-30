import { existsSync } from "node:fs";
import type { EventKey, EventType, ScoutEvent, UnsubscribeEventHandler } from "../events/index.js";
import { EventSubscriptionPriorities } from "../events/index.js";
import { Journal, JournalWriter, readJournalEvents, type JournalLocation } from "../journal/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { WorkflowEvents, type WorkflowBoundaryEvent } from "../workflow/workflow-events.js";

/** Persisted event metadata exposed without exposing the underlying Journal handle. */
export interface RecordEvent<TPayload = unknown> extends Omit<ScoutEvent<TPayload>, "key"> {
  key: EventKey;
  version: 1;
  seq: number;
  recordedAt: string;
}

export interface RecordWriteFailure {
  event: ScoutEvent;
  recordId: string;
  error: unknown;
  failedAt: string;
}

/** A record-owned resource transaction; business state is not part of it. */
export interface RecordWorkflowChange {
  readonly journalRoot: string;
  readonly checkpointSeq: number;
  commit(): void;
  abort(): void;
  releasePrevious(): void;
}

/** Owns one Workflow-scoped recording file and its event/explicit write paths. */
export abstract class RecordableObject {
  abstract readonly eventTypes: readonly EventType[];
  private activeJournal?: Journal;
  private activeRoot?: string;
  private writer?: JournalWriter;
  private started = false;
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];
  private readonly preparedJournals = new Set<Journal>();
  private readonly previousJournals = new Set<Journal>();
  private readonly failedClosures = new Map<Journal, unknown>();
  private preparation?: RecordWorkflowChange;

  protected constructor(private readonly name: string) {}

  static readFile(path: string): RecordEvent[] { return readJournalEvents(path); }

  protected abstract location(journalRoot: string): JournalLocation;

  /** Producers supply their own initial facts; the common layer does not interpret them. */
  protected workflowBaseline(): readonly ScoutEvent[] { return []; }

  protected onWriteSuccess(): void {}

  protected onWriteFailure(failure: RecordWriteFailure): void {
    currentRunScope().logger.warn({
      module: "record", event: "record_write_failed",
      message: `Failed to append ${failure.event.key.routeKey} to ${failure.recordId}.`,
      data: { recordId: failure.recordId, failedEventId: failure.event.id, error: String(failure.error) },
    });
  }

  start(): void {
    if (this.started) return;
    const scope = currentRunScope();
    if (!this.activeJournal && scope.workflow.snapshot()) {
      const root = scope.workflow.journalRoot;
      const location = this.location(root);
      this.activeJournal = existsSync(location.path) ? Journal.open(location) : Journal.create(location);
      this.activeRoot = root;
    }
    // Every resource participant uses the same priority. Failed preparation or
    // cleanup therefore waits for all peers instead of skipping lower groups.
    const options = { priority: EventSubscriptionPriorities.Critical };
    this.unsubscribers.push(
      scope.eventBus.subscribe<WorkflowBoundaryEvent>(WorkflowEvents.workflow.preparing, async ({ payload }) => {
        await this.prepareWorkflow(payload.journalRoot);
      }, options),
      scope.eventBus.subscribe<WorkflowBoundaryEvent>(WorkflowEvents.workflow.committing, ({ payload }) => {
        if (!this.preparation || this.preparation.journalRoot !== payload.journalRoot) {
          throw new Error(`${this.name} has no preparation for ${payload.workflowId}.`);
        }
        this.preparation.commit();
      }, options),
      scope.eventBus.subscribe(WorkflowEvents.workflow.aborting, () => {
        this.abortPreparedWorkflow();
      }, options),
      scope.eventBus.subscribe(WorkflowEvents.workflow.releasingPrevious, () => {
        this.releasePrevious();
      }, options),
      scope.eventBus.subscribe(WorkflowEvents.workflow.releasing, () => {
        this.releaseWorkflow();
      }, options),
    );
    this.started = true;
    if (this.activeJournal) this.requireWriter().start();
  }

  /** Detaches subscriptions; owned resources remain available for explicit writes. */
  stop(): void {
    this.started = false;
    this.writer?.stop();
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
  }

  create(journalRoot: string, baseline: readonly ScoutEvent[] = []): void {
    if (this.activeJournal) throw new Error(`${this.name} journal is already available.`);
    this.prepareWorkflow(journalRoot, baseline).commit();
  }

  open(journalRoot: string): void {
    if (this.activeJournal) throw new Error(`${this.name} journal is already available.`);
    this.activeJournal = Journal.open(this.location(journalRoot));
    this.activeRoot = journalRoot;
  }

  write(event: ScoutEvent): RecordEvent {
    this.requireJournal();
    return this.requireWriter().write(event);
  }

  readAll(): RecordEvent[] {
    if (!this.activeJournal && !currentRunScope().workflow.snapshot()) return [];
    return this.requireJournal().readAll();
  }

  get hasActiveRecord(): boolean { return this.activeJournal !== undefined; }
  get hasPreparedRecords(): boolean { return this.preparedJournals.size > 0; }
  get preparedCheckpointSeq(): number {
    if (!this.preparation || !this.hasPreparedRecords) throw new Error(`${this.name} preparation is unavailable.`);
    return this.preparation.checkpointSeq;
  }
  get lastSeq(): number { return this.requireJournal().lastSeq; }
  get journalRoot(): string {
    if (!this.activeRoot) throw new Error(`${this.name} journal root is unavailable.`);
    return this.activeRoot;
  }
  get path(): string { return this.requireJournal().path; }
  get failed(): boolean { return this.requireJournal().failed; }

  prepareWorkflow(journalRoot: string, baseline?: readonly ScoutEvent[]): RecordWorkflowChange {
    if (this.failedClosures.size > 0) {
      throw new AggregateError(this.failedClosures.values(), `Cannot prepare ${this.name} Workflow after journal cleanup failed.`);
    }
    if (this.preparedJournals.size > 0) throw new Error(`${this.name} already has a prepared Workflow journal.`);
    const previousJournal = this.activeJournal;
    const nextJournal = Journal.create(this.location(journalRoot));
    this.preparedJournals.add(nextJournal);
    try {
      const events = baseline ?? this.workflowBaseline();
      if (events.length > 0 || baseline !== undefined) nextJournal.replaceAll(events);
    } catch (error) {
      try {
        this.releaseJournal(nextJournal);
        this.preparedJournals.delete(nextJournal);
      } catch (closeError) {
        throw new AggregateError([error, closeError], `Failed to prepare and close ${this.name} journal.`);
      }
      throw error;
    }
    let committed = false;
    const change: RecordWorkflowChange = {
      journalRoot,
      checkpointSeq: nextJournal.lastSeq,
      commit: () => {
        if (this.failedClosures.has(nextJournal)) throw this.failedClosures.get(nextJournal);
        if (!this.preparedJournals.has(nextJournal) || this.activeJournal !== previousJournal) {
          throw new Error(`Cannot commit an inactive ${this.name} Workflow preparation.`);
        }
        this.preparedJournals.delete(nextJournal);
        if (previousJournal) this.previousJournals.add(previousJournal);
        this.activeJournal = nextJournal;
        this.activeRoot = journalRoot;
        committed = true;
        if (this.started) this.requireWriter().start();
      },
      abort: () => {
        if (committed) throw new Error(`Cannot abort a committed ${this.name} Workflow.`);
        if (!this.preparedJournals.has(nextJournal)) return;
        this.releaseJournal(nextJournal);
        this.preparedJournals.delete(nextJournal);
        if (this.preparation === change) this.preparation = undefined;
      },
      releasePrevious: () => {
        if (!committed) throw new Error(`Cannot release the current ${this.name} Workflow.`);
        if (!previousJournal || !this.previousJournals.has(previousJournal)) return;
        this.releaseJournal(previousJournal);
        this.previousJournals.delete(previousJournal);
      },
    };
    this.preparation = change;
    return change;
  }

  abortPreparedWorkflow(): void {
    const failures: unknown[] = [];
    for (const journal of this.preparedJournals) {
      try {
        this.releaseJournal(journal);
        this.preparedJournals.delete(journal);
      } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, `Failed to abort ${this.name} prepared resources.`);
    this.preparation = undefined;
  }

  releasePrevious(): void {
    const failures: unknown[] = [];
    for (const journal of this.previousJournals) {
      try {
        this.releaseJournal(journal);
        this.previousJournals.delete(journal);
      } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, `Failed to release previous ${this.name} resources.`);
  }

  /** Releases recording resources while retaining participation in future Workflow boundaries. */
  releaseWorkflow(): void {
    this.writer?.stop();
    const failures: unknown[] = [];
    for (const journal of new Set([
      ...this.preparedJournals, ...this.previousJournals,
      ...(this.activeJournal ? [this.activeJournal] : []),
    ])) {
      try {
        this.releaseJournal(journal);
        this.preparedJournals.delete(journal);
        this.previousJournals.delete(journal);
        if (this.activeJournal === journal) {
          this.activeJournal = undefined;
          this.activeRoot = undefined;
        }
      } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, `Failed to close ${this.name} journal resources.`);
    this.preparation = undefined;
  }

  close(): void {
    this.stop();
    this.releaseWorkflow();
  }

  private requireJournal(): Journal {
    if (!this.activeJournal) throw new Error(`${this.name} journal is unavailable.`);
    return this.activeJournal;
  }

  private requireWriter(): JournalWriter {
    if (!this.writer) {
      this.writer = new JournalWriter({
        eventBus: currentRunScope().eventBus,
        eventTypes: this.eventTypes,
        journal: () => this.requireJournal(),
        onSuccess: () => this.onWriteSuccess(),
        onFailure: ({ journalId, ...failure }) => this.onWriteFailure({ ...failure, recordId: journalId }),
      });
    }
    return this.writer;
  }

  private releaseJournal(journal: Journal): void {
    if (this.failedClosures.has(journal)) throw this.failedClosures.get(journal);
    try { journal.close(); }
    catch (error) {
      // A later no-op close is not evidence that a failed lock release succeeded.
      this.failedClosures.set(journal, error);
      throw error;
    }
  }
}
