import type { RbtRecord } from "../record/rbt-record.js";
import type { ScoutDomainRuntimeFact } from "../../../types.js";
import { RbtEvents, type RbtExecutionHistoryReadyEvent, type RbtExecutionPackSubmittedEvent, type RbtReviewSubmittedEvent } from "../rbt-events.js";

export interface RbtRuntimeFact extends ScoutDomainRuntimeFact {
  domainId: "rbt";
  histories: Array<RbtExecutionHistoryReadyEvent & { occurredAt: string }>;
  executionPacks: RbtExecutionPackSubmittedEvent[];
  reviews: RbtReviewSubmittedEvent[];
}

/** Rebuilds RBT runtime facts without publishing historical events or executing commands. */
export class RbtDomainProjector {
  project(events: readonly RbtRecord[]): RbtRuntimeFact {
    const fact: RbtRuntimeFact = { domainId: "rbt", journalSeq: 0, histories: [], executionPacks: [], reviews: [] };
    for (const event of events) {
      fact.journalSeq = event.seq;
      fact.updatedAt = event.occurredAt;
      if (RbtEvents.history.ready.is(event)) fact.histories.push({ ...structuredClone(event.payload), occurredAt: event.occurredAt });
      else if (RbtEvents.artifact.executionPackSubmitted.is(event)) fact.executionPacks.push(structuredClone(event.payload));
      else if (RbtEvents.artifact.reviewSubmitted.is(event)) fact.reviews.push(structuredClone(event.payload));
    }
    return fact;
  }
}
