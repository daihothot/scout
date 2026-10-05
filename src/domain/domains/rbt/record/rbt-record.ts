import { readArtifactReference } from "../../../../core/io/index.js";
import type { RecordEvent } from "../../../../core/record/index.js";
import type { RbtArtifactReference, RbtExecutionPackReference, RbtReviewerPackReference } from "../artifacts/types.js";

/** The flat persisted history payload; event and runtime fields do not define this format. */
export interface RbtExecutionHistoryRecord {
  bddId: string;
  targetVersion: string;
  platform: { type: string; version: string };
  executorHistoryRef: string;
  executorHistoryDigest: string;
  executeFileRef: string;
  executeFileDigest: string;
  runtimeSequence: number;
  campaignId: string;
  scenarioId: string;
  status: "completed" | "failed";
  agentId: string;
  role: string;
}

export interface RbtExecutionPackSubmissionRecord {
  bddId: string;
  targetVersion: string;
  taskId: string;
  stepId: string;
  submittedAt: string;
  pack: RbtExecutionPackReference;
}

export interface RbtReviewSubmissionRecord {
  bddId: string;
  targetVersion: string;
  taskId: string;
  stepId: string;
  submittedAt: string;
  pack: RbtReviewerPackReference;
}

/** kind discriminates decoded records only; the Journal retains its existing event envelope. */
export type RbtRecord =
  | (RecordEvent<RbtExecutionHistoryRecord, "domain.rbt.history.ready"> & { kind: "execution-history" })
  | (RecordEvent<RbtExecutionPackSubmissionRecord, "domain.rbt.artifact.execution_pack_submitted"> & { kind: "execution-pack" })
  | (RecordEvent<RbtReviewSubmissionRecord, "domain.rbt.artifact.review_submitted"> & { kind: "review" });

export function decodeRbtRecords(records: readonly RecordEvent[]): RbtRecord[] {
  return records.map((record): RbtRecord => {
    const invalid = (field: string): never => { throw new Error(`Invalid RBT record ${record.seq} (${record.key.routeKey}): ${field}`); };
    const object = (value: unknown, field: string): Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(field);
      return value as Record<string, unknown>;
    };
    const text = (value: Record<string, unknown>, field: string): string => {
      const result = value[field];
      if (typeof result !== "string" || !result) return invalid(field);
      return result;
    };
    const platform = (value: unknown): { type: string; version: string } => {
      const identity = object(value, "platform");
      return { type: text(identity, "type"), version: text(identity, "version") };
    };
    const reference = (ref: Record<string, unknown>): RbtArtifactReference => {
      const algorithm = ref.algorithm;
      if (algorithm !== "sha256" && algorithm !== "scout-directory-sha256-v1") return invalid("artifact algorithm");
      return {
        ...readArtifactReference(ref),
        digest: text(ref, "digest"), algorithm,
      };
    };
    const executionPack = (value: unknown): RbtExecutionPackReference => {
      const pack = object(value, "execution pack");
      return { ...reference(pack), executeFile: reference(object(pack.executeFile, "executeFile reference")) };
    };
    const sequence = (value: unknown): number => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return invalid("runtimeSequence");
      return value;
    };
    const payload = object(record.payload, "payload");
    const bddId = text(payload, "bddId");
    const targetVersion = text(payload, "targetVersion");
    switch (record.key.routeKey) {
      case "domain.rbt.history.ready": {
        const status = payload.status;
        if (status !== "completed" && status !== "failed") return invalid("status");
        return {
          ...record, key: { ...record.key, routeKey: "domain.rbt.history.ready" }, kind: "execution-history",
          payload: {
            bddId, targetVersion, platform: platform(payload.platform),
            executorHistoryRef: text(payload, "executorHistoryRef"), executorHistoryDigest: text(payload, "executorHistoryDigest"),
            executeFileRef: text(payload, "executeFileRef"), executeFileDigest: text(payload, "executeFileDigest"),
            runtimeSequence: sequence(payload.runtimeSequence), campaignId: text(payload, "campaignId"),
            scenarioId: text(payload, "scenarioId"), status, agentId: text(payload, "agentId"), role: text(payload, "role"),
          },
        };
      }
      case "domain.rbt.artifact.execution_pack_submitted":
      case "domain.rbt.artifact.review_submitted": {
        const submission = { bddId, targetVersion, taskId: text(payload, "taskId"), stepId: text(payload, "stepId"), submittedAt: text(payload, "submittedAt") };
        if (record.key.routeKey === "domain.rbt.artifact.execution_pack_submitted") {
          return {
            ...record, key: { ...record.key, routeKey: "domain.rbt.artifact.execution_pack_submitted" }, kind: "execution-pack",
            payload: { ...submission, pack: executionPack(payload.pack) },
          };
        }
        const pack = object(payload.pack, "reviewer pack");
        const result = pack.result;
        if (result !== "pass" && result !== "attention" && result !== "fail") return invalid("review result");
        const execution = object(pack.execution, "execution reference");
        return {
          ...record, key: { ...record.key, routeKey: "domain.rbt.artifact.review_submitted" }, kind: "review",
          payload: { ...submission, pack: {
            ...reference(pack), result, executionPack: executionPack(pack.executionPack),
            execution: {
              workflowId: text(execution, "workflowId"), agentId: text(execution, "agentId"),
              campaignId: text(execution, "campaignId"), scenarioId: text(execution, "scenarioId"),
              runtimeSequence: sequence(execution.runtimeSequence), platform: platform(execution.platform),
              executeFile: reference(object(execution.executeFile, "executeFile reference")),
              executorHistory: reference(object(execution.executorHistory, "executorHistory reference")),
            },
          } },
        };
      }
      default: return invalid("unsupported event route");
    }
  });
}
