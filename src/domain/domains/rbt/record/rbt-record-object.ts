import { currentRunScope } from "../../../../run/run-scope.js";
import type { RecordEvent, RecordWriteFailure } from "../../../../core/record/index.js";
import { SystemEvents } from "../../../../system/events/index.js";
import { DomainRecordObject } from "../../../core/record/index.js";
import { ScoutDomainId } from "../../../types.js";
import { RbtEvents } from "../rbt-events.js";
import { decodeRbtRecords, type RbtRecord } from "./rbt-record.js";

/** Declares RBT events and rebuilds its persisted execution histories. */
export class RbtRecordObject extends DomainRecordObject<RbtRecord> {
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

  protected decode(records: readonly RecordEvent[]): RbtRecord[] { return decodeRbtRecords(records); }

  protected override onWriteFailure(failure: RecordWriteFailure): void {
    super.onWriteFailure(failure);
    currentRunScope().eventBus.publish(SystemEvents.interaction.disclosureRequested, {
      level: "warn", source: "domain.rbt.record",
      message: `RBT fact was not recorded: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
    });
  }

}
