import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EventType, ScoutEvent } from "../../../core/events/index.js";
import {
  Journal,
  JournalWriter,
  type JournalEvent,
  type JournalLocation,
} from "../../../core/journal/index.js";
import { currentRunScope } from "../../../run/run-scope.js";
import type {
  ScoutDomainWorkflowChange,
  ScoutDomainId,
  ScoutDomainJournalEvent,
  ScoutDomainJournalFact,
  ScoutDomainJournalProjection,
  ScoutDomainRuntimeFact,
} from "../../types.js";

/**
 * Owns one Domain's journal resources, event writer, and prepared Workflow changes.
 * Concrete journals retain their event contracts and domain-specific projections.
 */
export abstract class DomainJournal<
  TRuntimeFact extends ScoutDomainRuntimeFact,
> implements ScoutDomainJournalProjection<TRuntimeFact> {
  abstract readonly eventTypes: readonly EventType[];
  private activeJournal?: Journal;
  private writer?: JournalWriter;
  private readonly preparedJournals = new Set<Journal>();
  private readonly previousJournals = new Set<Journal>();
  private readonly failedClosures = new Map<Journal, unknown>();

  protected constructor(private readonly identity: {
    readonly domainId: ScoutDomainId;
    readonly name: string;
    readonly fileName: string;
    readonly lockFileName: string;
  }) {}

  abstract project(event: ScoutEvent, journalSeq: number): ScoutDomainJournalFact | undefined;

  abstract aggregate(events: readonly ScoutDomainJournalEvent[]): TRuntimeFact;

  start(): void {
    if (this.writer) return;
    const scope = currentRunScope();
    if (!this.activeJournal) {
      if (!scope.workflow.snapshot()) return;
      const location = this.location(scope.workflow.journalRoot);
      this.activeJournal = existsSync(location.path) ? Journal.open(location) : Journal.create(location);
    }
    const writer = new JournalWriter({
      eventBus: scope.eventBus,
      eventTypes: this.eventTypes,
      journal: () => this.requireJournal(),
      onFailure: (failure) => scope.logger.warn({
        module: `domain.${this.identity.domainId}.journal`,
        event: `${this.identity.domainId}_domain_journal_write_failed`,
        message: `Failed to append ${failure.event.key.routeKey} to ${failure.journalId}.`,
        data: {
          journalId: failure.journalId,
          failedEventId: failure.event.id,
          failedEventKey: failure.event.key.routeKey,
          failedAt: failure.failedAt,
          error: failure.error instanceof Error
            ? failure.error.stack ?? failure.error.message
            : String(failure.error),
        },
      }),
    });
    writer.start();
    this.writer = writer;
  }

  stop(): void {
    this.writer?.stop();
    this.writer = undefined;
  }

  append(event: ScoutEvent): JournalEvent {
    return this.requireJournal().append(event);
  }

  readAll(): JournalEvent[] {
    if (!this.activeJournal && !currentRunScope().workflow.snapshot()) return [];
    return this.requireJournal().readAll();
  }

  prepareWorkflow(journalRoot: string): ScoutDomainWorkflowChange {
    if (this.failedClosures.size > 0) {
      throw new AggregateError(
        this.failedClosures.values(),
        `Cannot prepare ${this.identity.name} Workflow after journal cleanup failed.`,
      );
    }
    if (this.preparedJournals.size > 0) {
      throw new Error(`${this.identity.name} already has a prepared Workflow journal.`);
    }
    const previousJournal = this.activeJournal;
    const nextJournal = Journal.create(this.location(journalRoot));
    this.preparedJournals.add(nextJournal);
    let committed = false;
    return {
      commit: () => {
        if (this.failedClosures.has(nextJournal)) throw this.failedClosures.get(nextJournal);
        if (
          !this.preparedJournals.has(nextJournal)
          || this.activeJournal !== previousJournal
        ) {
          throw new Error(`Cannot commit an inactive ${this.identity.name} Workflow preparation.`);
        }
        this.preparedJournals.delete(nextJournal);
        if (previousJournal) this.previousJournals.add(previousJournal);
        this.activeJournal = nextJournal;
        this.start();
        committed = true;
      },
      abort: () => {
        if (committed) throw new Error(`Cannot abort a committed ${this.identity.name} Workflow.`);
        if (!this.preparedJournals.has(nextJournal)) return;
        this.releaseJournal(nextJournal);
        this.preparedJournals.delete(nextJournal);
      },
      releasePrevious: () => {
        if (!committed) throw new Error(`Cannot release the current ${this.identity.name} Workflow.`);
        if (!previousJournal || !this.previousJournals.has(previousJournal)) return;
        this.releaseJournal(previousJournal);
        this.previousJournals.delete(previousJournal);
      },
    };
  }

  close(): void {
    this.stop();
    const failures: unknown[] = [];
    const journals = new Set([
      ...this.preparedJournals,
      ...this.previousJournals,
      ...(this.activeJournal ? [this.activeJournal] : []),
    ]);
    for (const journal of journals) {
      try {
        this.releaseJournal(journal);
        this.preparedJournals.delete(journal);
        this.previousJournals.delete(journal);
        if (this.activeJournal === journal) this.activeJournal = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to close ${this.identity.name} journal resources.`);
    }
  }

  private requireJournal(): Journal {
    if (!this.activeJournal) throw new Error(`${this.identity.name} journal is unavailable.`);
    return this.activeJournal;
  }

  private releaseJournal(journal: Journal): void {
    if (this.failedClosures.has(journal)) throw this.failedClosures.get(journal);
    try {
      journal.close();
    } catch (error) {
      this.failedClosures.set(journal, error);
      throw error;
    }
  }

  private location(journalRoot: string): JournalLocation {
    return {
      journalId: this.identity.domainId,
      path: join(journalRoot, this.identity.fileName),
      lockPath: join(journalRoot, this.identity.lockFileName),
    };
  }
}
