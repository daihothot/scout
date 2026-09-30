import { currentRunScope } from "../../../run/run-scope.js";
import type { RecordWriteFailure } from "../../../core/record/index.js";
import { SystemEvents } from "../../../system/events/index.js";
import { DomainRecordObject } from "../../core/record/index.js";
import {
  ScoutDomainId,
  type ScoutDomainRecordEvent,
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
export class RbtRecordObject extends DomainRecordObject<RbtRuntimeFact> {
  readonly eventTypes = [
    RbtEvents.history.ready,
    RbtEvents.artifact.executionPackSubmitted,
    RbtEvents.artifact.reviewSubmitted,
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

  protected override onWriteFailure(failure: RecordWriteFailure): void {
    super.onWriteFailure(failure);
    currentRunScope().eventBus.publish(SystemEvents.interaction.disclosureRequested, {
      level: "warn", source: "domain.rbt.record",
      message: `RBT fact was not recorded: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
    });
  }

  aggregate(events: readonly ScoutDomainRecordEvent[]): RbtRuntimeFact {
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
