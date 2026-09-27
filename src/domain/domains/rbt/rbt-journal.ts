import { DomainJournal } from "../../core/journal/index.js";
import {
  ScoutDomainId,
  type ScoutDomainJournalEvent,
  type ScoutDomainRuntimeFact,
} from "../../types.js";
import { RbtEvents, type RbtExecutionHistoryReadyEvent } from "./rbt-events.js";

export interface RbtRuntimeFact extends ScoutDomainRuntimeFact {
  domainId: "rbt";
  histories: Array<RbtExecutionHistoryReadyEvent & {
    occurredAt: string;
  }>;
}

/** Declares RBT events and rebuilds its persisted execution histories. */
export class RbtJournal extends DomainJournal<RbtRuntimeFact> {
  readonly eventTypes = [
    RbtEvents.history.ready,
  ] as const;

  constructor() {
    super({
      domainId: ScoutDomainId.Rbt,
      name: "RBT Domain",
      fileName: "rbt-events.jsonl",
      lockFileName: ".rbt-events.lock",
    });
  }

  project(): undefined {
    return undefined;
  }

  aggregate(events: readonly ScoutDomainJournalEvent[]): RbtRuntimeFact {
    const fact: RbtRuntimeFact = { domainId: "rbt", journalSeq: 0, histories: [] };
    for (const event of events) {
      fact.journalSeq = event.seq;
      fact.updatedAt = event.occurredAt;
      if (RbtEvents.history.ready.is(event)) {
        fact.histories.push({
          ...structuredClone(event.payload),
          occurredAt: event.occurredAt,
        });
      }
    }
    return fact;
  }
}
