import { currentRunScope } from "../../../../run/run-scope.js";
import type { RecordEvent, RecordWriteFailure } from "../../../../core/record/index.js";
import type { ScoutEvent } from "../../../../core/events/index.js";
import { SystemEvents } from "../../../../system/events/index.js";
import { DomainRecordObject } from "../../../core/record/index.js";
import { ScoutDomainId } from "../../../types.js";
import { RbtEvents } from "../rbt-events.js";
import {
  decodeRbtRecords, type RbtRecord, type RbtExecutionHistoryRecord,
  type RbtExecutionPackSubmissionRecord, type RbtReviewSubmissionRecord,
} from "./rbt-record.js";

/** Serializes and decodes RBT records; the Domain projector rebuilds runtime indexes. */
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

  protected override encode(event: ScoutEvent): ScoutEvent {
    if (RbtEvents.history.ready.is(event)) {
      const history = event.payload;
      const payload: RbtExecutionHistoryRecord = {
        bddId: history.bddId, targetVersion: history.targetVersion, platform: { ...history.platform },
        executorHistoryRef: history.executorHistoryRef, executorHistoryDigest: history.executorHistoryDigest,
        executeFileRef: history.executeFileRef, executeFileDigest: history.executeFileDigest,
        runtimeSequence: history.runtimeSequence, campaignId: history.campaignId, scenarioId: history.scenarioId,
        status: history.status, agentId: history.agentId, role: history.role,
      };
      return { ...event, payload };
    }
    if (RbtEvents.artifact.executionPackSubmitted.is(event)) {
      const submission = event.payload;
      const payload: RbtExecutionPackSubmissionRecord = {
        bddId: submission.bddId, targetVersion: submission.targetVersion, taskId: submission.taskId,
        stepId: submission.stepId, submittedAt: submission.submittedAt, pack: structuredClone(submission.pack),
      };
      return { ...event, payload };
    }
    if (RbtEvents.artifact.reviewSubmitted.is(event)) {
      const submission = event.payload;
      const payload: RbtReviewSubmissionRecord = {
        bddId: submission.bddId, targetVersion: submission.targetVersion, taskId: submission.taskId,
        stepId: submission.stepId, submittedAt: submission.submittedAt, pack: structuredClone(submission.pack),
      };
      return { ...event, payload };
    }
    throw new Error(`Unsupported RBT event: ${event.key.routeKey}`);
  }

  protected override onWriteFailure(failure: RecordWriteFailure): void {
    super.onWriteFailure(failure);
    currentRunScope().eventBus.publish(SystemEvents.interaction.disclosureRequested, {
      level: "warn", source: "domain.rbt.record",
      message: `RBT fact was not recorded: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
    });
  }

}
