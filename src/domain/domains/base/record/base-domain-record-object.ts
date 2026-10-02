import { ExecutionEvents } from "../../../../execution/index.js";
import { DomainRecordObject } from "../../../core/record/index.js";
import { ScoutDomainId } from "../../../types.js";
import { BaseDomainEvents } from "../base-domain-events.js";
import { decodeBaseDomainRecords, type BaseDomainRecord } from "./base-domain-record.js";
import type { RecordEvent } from "../../../../core/record/index.js";

/** Declares Base events and rebuilds its execution and tool-call facts. */
export class BaseDomainRecordObject extends DomainRecordObject<BaseDomainRecord> {
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

  protected decode(records: readonly RecordEvent[]): BaseDomainRecord[] { return decodeBaseDomainRecords(records); }

}
