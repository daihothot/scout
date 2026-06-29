import type { AssetCommit } from "../asset-store/types.js";
import type { AgentThreadRecord } from "../agent/types.js";
import type { ScoutInput } from "../input/types.js";

export interface RuntimeContextBundle {
  contextBundleId: string;
  runId: string;
  assetCommit: AssetCommit;
  scoutInputRef: string;
  scoutInput: ScoutInput;
  validationTask: {
    id: string;
    title: string;
    objective: string;
  };
  sharedInputs: {
    mountRoot: string;
    manifestPath: string;
    preflightRef?: string;
    resourceHash: string;
  };
}

export function buildRuntimeContextBundle(input: {
  runId: string;
  assetCommit: RuntimeContextBundle["assetCommit"];
  scoutInputRef: string;
  scoutInput: RuntimeContextBundle["scoutInput"];
}): RuntimeContextBundle {
  return {
    contextBundleId: `cb_${input.assetCommit.assetCommitId.slice(3)}`,
    runId: input.runId,
    assetCommit: input.assetCommit,
    scoutInputRef: input.scoutInputRef,
    scoutInput: input.scoutInput,
    validationTask: {
      id: "scout-runtime-validation",
      title: "Scout runtime 编排验证",
      objective: "验证 Verifier 和 Validator 能够基于同一份 context bundle 创建彼此独立的 thread。",
    },
    sharedInputs: {
      mountRoot: input.assetCommit.mountRoot,
      manifestPath: input.assetCommit.manifestPath,
      preflightRef: input.assetCommit.preflightRef,
      resourceHash: input.assetCommit.resourceHash,
    },
  };
}

export interface RuntimeOrchestrationArtifact {
  artifactVersion: 1;
  runId: string;
  status: "passed" | "failed";
  contextBundle: RuntimeContextBundle;
  agentThreads: AgentThreadRecord[];
  gates: {
    isolatedThreads: boolean;
    sharedContextBundle: boolean;
  };
  error?: string;
}
