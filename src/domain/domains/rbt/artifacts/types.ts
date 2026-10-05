import type { ScoutArtifactReference } from "../../../../core/io/index.js";
import type { ScoutAgentRole } from "../../../../agent/thread/types.js";
import type { ExecutionPlatformIdentity } from "../../../../execution/scout-execution-system.js";

/** Content identity at the time a logically addressed Artifact fact was recorded. */
export interface RbtArtifactReference extends ScoutArtifactReference {
  digest: string;
  algorithm: "sha256" | "scout-directory-sha256-v1";
}

export interface RbtExecutionReference {
  workflowId: string;
  agentId: string;
  runtimeSequence: number;
  campaignId: string;
  scenarioId: string;
  platform: { type: string; version: string };
  executeFile: RbtArtifactReference;
}

export interface RbtExecutionHistoryReference extends RbtExecutionReference {
  executorHistory: RbtArtifactReference;
}

export interface RbtExecutionPackReference extends RbtArtifactReference {
  executeFile: RbtArtifactReference;
}

export type RbtReviewResult = "pass" | "attention" | "fail";

export interface RbtReviewerPackReference extends RbtArtifactReference {
  result: RbtReviewResult;
  executionPack: RbtExecutionPackReference;
  execution: RbtExecutionHistoryReference;
}

/** Finalized execution facts used for artifact association and Coordinator delivery. */
export interface RbtExecutionHistory {
  bddId: string;
  targetVersion: string;
  platform: ExecutionPlatformIdentity;
  executorHistoryRef: string;
  executorHistoryDigest: string;
  executeFileRef: string;
  executeFileDigest: string;
  runtimeSequence: number;
  campaignId: string;
  scenarioId: string;
  status: "completed" | "failed";
  agentId: string;
  role: ScoutAgentRole;
}

/** One accepted formal Execution Pack submission. */
export interface RbtExecutionPackSubmission {
  bddId: string;
  targetVersion: string;
  taskId: string;
  stepId: string;
  submittedAt: string;
  pack: RbtExecutionPackReference;
}

/** One accepted review of a submitted Execution Pack and its execution evidence. */
export interface RbtReviewSubmission {
  bddId: string;
  targetVersion: string;
  taskId: string;
  stepId: string;
  submittedAt: string;
  pack: RbtReviewerPackReference;
}

/** Complete Workflow-scoped artifact indexes, ready to install after projection. */
export interface RbtArtifactData {
  histories: Map<string, { history: RbtExecutionHistory; occurredAt: string }>;
  executionPacks: RbtExecutionPackSubmission[];
  acceptedSubmissions: Set<string>;
}
