import type { EventBus, EventType, ScoutEvent, UnsubscribeEventHandler } from "../events/index.js";
import { EventSubscriptionPriorities } from "../events/index.js";
import type { JournalEvent } from "./journal-event.js";
import type { Journal } from "./journal.js";

export interface JournalWriteFailure {
  event: ScoutEvent;
  journalId: string;
  error: unknown;
  failedAt: string;
}

/** Shared event-to-Journal binding with one retry per append. */
export class JournalWriter {
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];

  constructor(private readonly input: {
    eventBus: EventBus;
    eventTypes: readonly EventType[];
    journal: () => Journal;
    onSuccess?(): void;
    onFailure?(failure: JournalWriteFailure): void;
  }) {}

  start(): void {
    if (this.unsubscribers.length > 0) return;
    const eventTypes = [...new Map(
      this.input.eventTypes.map((type) => [type.routeKey, type]),
    ).values()];
    for (const type of eventTypes) {
      this.unsubscribers.push(this.input.eventBus.subscribe(type, (event) => {
        try {
          this.write(event);
        } catch {
          // Observational event recording remains best effort. Explicit writes
          // use write() directly when their caller requires a durable fact.
        }
      }, { priority: EventSubscriptionPriorities.High }));
    }
  }

  /** Appends one durable fact, reporting and throwing after both attempts fail. */
  write(event: ScoutEvent): JournalEvent {
    const journal = this.input.journal();
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let recorded: JournalEvent;
      try {
        recorded = journal.append(event);
      } catch (error) {
        failure = error;
        continue;
      }
      this.input.onSuccess?.();
      return recorded;
    }
    try {
      this.input.onFailure?.({
        event,
        journalId: journal.journalId,
        error: failure,
        failedAt: new Date().toISOString(),
      });
    } finally {
      // Failure disclosure must not hide the actual persistence failure.
      throw failure;
    }
  }

  stop(): void {
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
  }
}
