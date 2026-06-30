import type { AssetCommit } from "../asset-store/types.js";
import type { AgentThreadRecord } from "../agent/model/types.js";

export interface RunContextBundle {
  contextBundleId: string;
  runId: string;
  assetCommit: AssetCommit;
  sharedInputs: {
    mountRoot: string;
    manifestPath: string;
    preflightRef?: string;
    resourceHash: string;
  };
}

export function buildRunContextBundle(input: {
  runId: string;
  assetCommit: RunContextBundle["assetCommit"];
}): RunContextBundle {
  return {
    contextBundleId: `cb_${input.assetCommit.assetCommitId.slice(3)}`,
    runId: input.runId,
    assetCommit: input.assetCommit,
    sharedInputs: {
      mountRoot: input.assetCommit.mountRoot,
      manifestPath: input.assetCommit.manifestPath,
      preflightRef: input.assetCommit.preflightRef,
      resourceHash: input.assetCommit.resourceHash,
    },
  };
}

export interface RunOrchestrationArtifact {
  artifactVersion: 1;
  runId: string;
  status: "passed" | "failed";
  contextBundle: RunContextBundle;
  agentThreads: AgentThreadRecord[];
  gates: {
    isolatedThreads: boolean;
    sharedContextBundle: boolean;
  };
  error?: string;
}
