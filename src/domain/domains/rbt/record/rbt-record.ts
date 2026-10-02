import type { RecordEvent } from "../../../../core/record/index.js";
import type { RbtExecutionHistoryReadyEvent, RbtExecutionPackSubmittedEvent, RbtReviewSubmittedEvent } from "../rbt-events.js";

/** Decoded RBT evidence facts; projection and business indexing are separate consumers. */
export type RbtRecord =
  | RecordEvent<RbtExecutionHistoryReadyEvent, "domain.rbt.history.ready">
  | RecordEvent<RbtExecutionPackSubmittedEvent, "domain.rbt.artifact.execution_pack_submitted">
  | RecordEvent<RbtReviewSubmittedEvent, "domain.rbt.artifact.review_submitted">;

export function decodeRbtRecords(records: readonly RecordEvent[]): RbtRecord[] {
  return records.map((record) => {
    const invalid = (field: string): never => { throw new Error(`Invalid RBT record ${record.seq} (${record.key.routeKey}): ${field}`); };
    const object = (value: unknown, field: string): Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
      return value as Record<string, unknown>;
    };
    const strings = (value: Record<string, unknown>, fields: readonly string[]): void => {
      for (const field of fields) if (typeof value[field] !== "string" || !value[field]) invalid(field);
    };
    const platform = (value: unknown): void => { strings(object(value, "platform"), ["type", "version"]); };
    const reference = (value: unknown): Record<string, unknown> => {
      const ref = object(value, "artifact reference");
      strings(ref, ["workflowId", "agentId", "path", "digest"]);
      if (ref.algorithm !== "sha256" && ref.algorithm !== "scout-directory-sha256-v1") invalid("artifact algorithm");
      return ref;
    };
    const executionPack = (value: unknown): void => { reference(reference(value).executeFile); };
    const sequence = (value: unknown): void => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid("runtimeSequence");
    };
    const payload = object(record.payload, "payload");
    strings(payload, ["bddId", "targetVersion"]);
    switch (record.key.routeKey) {
      case "domain.rbt.history.ready":
        strings(payload, ["executorHistoryRef", "executorHistoryDigest", "executeFileRef", "executeFileDigest", "campaignId", "scenarioId", "agentId", "role"]);
        platform(payload.platform);
        sequence(payload.runtimeSequence);
        if (payload.status !== "completed" && payload.status !== "failed") invalid("status");
        break;
      case "domain.rbt.artifact.execution_pack_submitted":
      case "domain.rbt.artifact.review_submitted": {
        strings(payload, ["taskId", "stepId", "submittedAt"]);
        if (record.key.routeKey === "domain.rbt.artifact.execution_pack_submitted") executionPack(payload.pack);
        else {
          const pack = reference(payload.pack);
          if (pack.result !== "pass" && pack.result !== "attention" && pack.result !== "fail") invalid("review result");
          executionPack(pack.executionPack);
          const execution = object(pack.execution, "execution reference");
          strings(execution, ["workflowId", "agentId", "campaignId", "scenarioId"]);
          sequence(execution.runtimeSequence);
          platform(execution.platform);
          reference(execution.executeFile);
          reference(execution.executorHistory);
        }
        break;
      }
      default: invalid("unsupported event route");
    }
    return structuredClone(record) as RbtRecord;
  });
}
