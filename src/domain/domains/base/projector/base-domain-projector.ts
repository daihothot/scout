import type { BaseDomainRecord } from "../record/base-domain-record.js";
import type { ScoutDomainRuntimeFact } from "../../../types.js";
import { BaseDomainEvents, type BaseDomainAgentToolCallObservedEvent } from "../base-domain-events.js";
import { projectBaseExecutionEvent, type BaseDomainExecutionState } from "../execution/base-domain-execution-state.js";

/** Complete Base execution and call history rebuilt without starting any operation. */
export interface BaseDomainRuntimeFact extends ScoutDomainRuntimeFact {
  domainId: "base";
  execution?: BaseDomainExecutionState;
  toolCalls: BaseDomainAgentToolCallObservedEvent[];
}

export class BaseDomainProjector {
  project(events: readonly BaseDomainRecord[]): BaseDomainRuntimeFact {
    const fact: BaseDomainRuntimeFact = { domainId: "base", journalSeq: 0, toolCalls: [] };
    const calls = new Map<string, BaseDomainAgentToolCallObservedEvent>();
    for (const event of events) {
      fact.journalSeq = event.seq;
      fact.updatedAt = event.occurredAt;
      fact.execution = projectBaseExecutionEvent(fact.execution, event);
      if (BaseDomainEvents.agentToolCall.observed.is(event)) calls.set(event.payload.callId, structuredClone(event.payload));
    }
    fact.toolCalls = [...calls.values()];
    return fact;
  }
}
