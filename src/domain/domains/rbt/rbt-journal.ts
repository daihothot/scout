import { randomUUID } from "node:crypto";
import { currentRunScope } from "../../../run/run-scope.js";
import { DomainJournal } from "../../core/journal/index.js";
import {
  ScoutDomainId,
  type ScoutDomainJournalEvent,
  type ScoutDomainRuntimeFact,
} from "../../types.js";
import { RbtEvents, type RbtExecutionHistoryReadyEvent, type RbtExecutionPackSubmittedEvent, type RbtReviewSubmittedEvent } from "./rbt-events.js";

export interface RbtRuntimeFact extends ScoutDomainRuntimeFact {
  domainId: "rbt";
  histories: Array<RbtExecutionHistoryReadyEvent & {
    occurredAt: string;
  }>;
  executionPacks: RbtExecutionPackSubmittedEvent[];
  reviews: RbtReviewSubmittedEvent[];
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

  /** Commit the captured artifact fact before exposing it to benchmark observers. */
  recordExecutionPack(payload: RbtExecutionPackSubmittedEvent): void {
    const event = { id: randomUUID(), key: RbtEvents.artifact.executionPackSubmitted, payload, occurredAt: payload.submittedAt };
    this.append(event);
    currentRunScope().eventBus.publish(event.key, payload, event);
  }

  recordReview(payload: RbtReviewSubmittedEvent): void {
    const event = { id: randomUUID(), key: RbtEvents.artifact.reviewSubmitted, payload, occurredAt: payload.submittedAt };
    this.append(event);
    currentRunScope().eventBus.publish(event.key, payload, event);
  }

  aggregate(events: readonly ScoutDomainJournalEvent[]): RbtRuntimeFact {
    const fact: RbtRuntimeFact = { domainId: "rbt", journalSeq: 0, histories: [], executionPacks: [], reviews: [] };
    for (const event of events) {
      fact.journalSeq = event.seq;
      fact.updatedAt = event.occurredAt;
      if (RbtEvents.history.ready.is(event)) {
        fact.histories.push({
          ...structuredClone(event.payload),
          occurredAt: event.occurredAt,
        });
      } else if (RbtEvents.artifact.executionPackSubmitted.is(event)) {
        fact.executionPacks.push(structuredClone(event.payload));
      } else if (RbtEvents.artifact.reviewSubmitted.is(event)) {
        fact.reviews.push(structuredClone(event.payload));
      }
    }
    return fact;
  }
}
