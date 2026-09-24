import type { ScoutEvent } from "../../core/events/index.js";
import {
  ExecutionEvents,
  type ExecutionCommandCompletedEvent,
  type ExecutionSelectionIdentity,
} from "../../execution/index.js";
import type {
  ScoutDomainJournalEvent,
  ScoutDomainJournalProjection,
  ScoutDomainRuntimeFact,
} from "../types.js";
import { RbtEvents, type RbtExecutionHistoryReadyEvent } from "./rbt-events.js";

type RbtExecutionState = "identified" | "launched" | "stopped";

export interface RbtRuntimeFact extends ScoutDomainRuntimeFact {
  domainId: "rbt";
  execution?: {
    selection: ExecutionSelectionIdentity;
    state: RbtExecutionState;
    correlationId: string;
    occurredAt: string;
  };
  latestHistory?: RbtExecutionHistoryReadyEvent & {
    occurredAt: string;
  };
}

/** Selects and folds the persisted runtime facts owned by the RBT Domain. */
export class RbtJournal implements ScoutDomainJournalProjection<RbtRuntimeFact> {
  readonly eventTypes = [
    ExecutionEvents.execution.identifyCompleted,
    ExecutionEvents.execution.launchCompleted,
    ExecutionEvents.execution.shutdownCompleted,
    RbtEvents.history.ready,
  ] as const;

  project(): undefined {
    return undefined;
  }

  aggregate(events: readonly ScoutDomainJournalEvent[]): RbtRuntimeFact {
    const fact: RbtRuntimeFact = { domainId: "rbt", journalSeq: 0 };
    for (const event of events) {
      fact.journalSeq = event.seq;
      fact.updatedAt = event.occurredAt;
      if (ExecutionEvents.execution.identifyCompleted.is(event)) {
        this.acceptExecution(fact, event, "identified");
      } else if (ExecutionEvents.execution.launchCompleted.is(event)) {
        this.acceptExecution(fact, event, "launched");
      } else if (ExecutionEvents.execution.shutdownCompleted.is(event)) {
        this.acceptExecution(fact, event, "stopped");
      } else if (RbtEvents.history.ready.is(event)) {
        fact.latestHistory = {
          ...structuredClone(event.payload),
          occurredAt: event.occurredAt,
        };
      }
    }
    return fact;
  }

  private acceptExecution(
    fact: RbtRuntimeFact,
    event: ScoutEvent<ExecutionCommandCompletedEvent>,
    state: RbtExecutionState,
  ): void {
    if (event.payload.result.ok) {
      fact.execution = {
        selection: structuredClone(event.payload.result.selection),
        state,
        correlationId: event.payload.correlationId,
        occurredAt: event.occurredAt,
      };
      return;
    }
    if (state === "identified" || event.payload.result.requiresIdentify) {
      fact.execution = undefined;
    }
  }
}
