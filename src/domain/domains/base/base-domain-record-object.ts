import { ExecutionEvents } from "../../../execution/index.js";
import {
  projectBaseExecutionEvent,
  type BaseDomainExecutionState,
} from "./execution/base-domain-execution-state.js";
import { DomainRecordObject } from "../../core/record/index.js";
import {
  ScoutDomainId,
  type ScoutDomainRecordEvent,
  type ScoutDomainRuntimeFact,
} from "../../types.js";
import {
  BaseDomainEvents,
  type BaseDomainAgentToolCallObservedEvent,
} from "./base-domain-events.js";

/** Shared runtime facts rebuilt from the Base Domain journal. */
export interface BaseDomainRuntimeFact extends ScoutDomainRuntimeFact {
  domainId: "base";
  execution?: BaseDomainExecutionState;
  toolCalls: BaseDomainAgentToolCallObservedEvent[];
}

/** Declares Base events and rebuilds its execution and tool-call facts. */
export class BaseDomainRecordObject extends DomainRecordObject<BaseDomainRuntimeFact> {
  readonly eventTypes = [
    ExecutionEvents.execution.identifyCompleted,
    ExecutionEvents.execution.launchCompleted,
    ExecutionEvents.execution.shutdownCompleted,
    BaseDomainEvents.agentToolCall.observed,
  ] as const;

  constructor() {
    super({
      domainId: ScoutDomainId.Base,
      name: "Base Domain",
      fileName: "base.journal",
      lockFileName: ".base.lock",
    });
  }

  project(): undefined {
    return undefined;
  }

  aggregate(events: readonly ScoutDomainRecordEvent[]): BaseDomainRuntimeFact {
    const fact: BaseDomainRuntimeFact = {
      domainId: "base",
      journalSeq: 0,
      toolCalls: [],
    };
    const calls = new Map<string, BaseDomainAgentToolCallObservedEvent>();
    for (const event of events) {
      fact.journalSeq = event.seq;
      fact.updatedAt = event.occurredAt;
      fact.execution = projectBaseExecutionEvent(fact.execution, event);
      if (BaseDomainEvents.agentToolCall.observed.is(event)) {
        calls.set(event.payload.callId, structuredClone(event.payload));
      }
    }
    fact.toolCalls = [...calls.values()];
    return fact;
  }
}
