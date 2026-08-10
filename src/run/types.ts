import type { ScoutAgentRole } from "../agent/thread/types.js";
import type { AgentServerPreflightReport } from "../agent-server/types.js";
import type { AssetCommit } from "../asset-store/contracts/asset-commit.js";
import type { CodexMount } from "../asset-store/contracts/mount.js";
import type { AgentThreadSnapshot } from "../agent/thread/types.js";
import type { RuntimeInteractionPort } from "../interaction/index.js";

/** CLI/runtime inputs shared by startup and resume. */
export interface ScoutRunOptions {
  cwd: string;
  interactionPort?: RuntimeInteractionPort;
}

/** Adds the run identifier or directory used to reconstruct a prior run. */
export interface ResumeRunOptions extends ScoutRunOptions {
  run: string;
}

/** Permission roots derived from the role mounts for one run. */
export interface RunRootAccess {
  mountRoots: string[];
  trustedRoots: string[];
  writableRoots: string[];
}

/** Prepared mount, preflight facts, and artifact locations for one role. */
export interface RunAgentEnvironment {
  role: ScoutAgentRole;
  mount: CodexMount;
  preflight: AgentServerPreflightReport;
  preflightPath: string;
  assetCommit: AssetCommit;
  assetCommitPath: string;
}

/** Complete environment consumed by later lifecycle stages. */
export interface RunEnvironment {
  agents: Record<ScoutAgentRole, RunAgentEnvironment>;
  rootAccess: RunRootAccess;
  contextBundle: RunContextBundle;
}

/** Persistable summary returned when startup or resume finishes. */
export interface ScoutRunSummary {
  status: "passed" | "failed";
  runId: string;
  coordinatorMountRoot: string;
  rootAccess: RunRootAccess;
  agents: Record<ScoutAgentRole, {
    mountId: string;
    mountRoot: string;
    artifactRoot: string;
    assetCommitId: string;
    assetCommitPath: string;
    preflightStatus: "passed" | "failed";
    preflightPath: string;
  }>;
}

/** Shared coordinator inputs and identity used by all agent threads. */
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

/** Builds the stable shared-context identity from a coordinator asset commit. */
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

/** Persisted orchestration facts used to inspect a completed run. */
export interface RunOrchestrationArtifact {
  artifactVersion: 1;
  runId: string;
  status: "passed" | "failed";
  contextBundle: RunContextBundle;
  agentThreads: AgentThreadSnapshot[];
  gates: {
    isolatedThreads: boolean;
    sharedContextBundle: boolean;
  };
  error?: string;
}
