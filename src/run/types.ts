import type { ScoutAgentRole } from "../agent/thread/types.js";
import type { AgentServerPreflightReport } from "../agent-server/types.js";
import type {
  AssetCommit,
  CodexMount,
} from "../asset-store/types.js";
import type { AgentThreadSnapshot } from "../agent/thread/types.js";
import type { RuntimeInteractionPort } from "../interaction/index.js";

export interface ScoutRunOptions {
  cwd: string;
  interactionPort?: RuntimeInteractionPort;
}

export interface ResumeRunOptions extends ScoutRunOptions {
  run: string;
}

export interface RunRootAccess {
  mountRoots: string[];
  trustedRoots: string[];
  writableRoots: string[];
}

export interface RunAgentEnvironment {
  role: ScoutAgentRole;
  mount: CodexMount;
  preflight: AgentServerPreflightReport;
  preflightPath: string;
  assetCommit: AssetCommit;
  assetCommitPath: string;
}

export interface RunEnvironment {
  agents: Record<ScoutAgentRole, RunAgentEnvironment>;
  rootAccess: RunRootAccess;
  contextBundle: RunContextBundle;
}

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
  agentThreads: AgentThreadSnapshot[];
  gates: {
    isolatedThreads: boolean;
    sharedContextBundle: boolean;
  };
  error?: string;
}
