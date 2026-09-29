import type { BenchmarkWorkflowReference } from "../../../../core/workflow/benchmarks/index.js";

/** Content identity at the time a fact was recorded; path is relative to an Agent artifact root. */
export interface RbtArtifactReference extends BenchmarkWorkflowReference {
  agentId: string;
  path: string;
  digest: string;
  algorithm: "sha256" | "scout-directory-sha256-v1";
}

export interface RbtExecutionReference extends BenchmarkWorkflowReference {
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
