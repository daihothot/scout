/**
 * Portable manifest persisted beside one role mount. Builders produce this
 * shape and inspectors verify it without adding behavior to the contract.
 */
import type { AgentProfile } from "./profile.js";
import type { MaterializedMcpServer } from "./resources.js";
import type { MountMaterializationIssue } from "./mount.js";
import type { MaterializedSkill } from "./skill.js";

/** Named runtime root projected for Agent resource navigation. */
export interface MountRuntimeRoot {
  name: "mount" | "artifacts" | "tmp";
  path: string;
  access: "read" | "read-write";
}

/** Portable manifest used to verify and reconstruct a role mount later. */
export interface MountManifest {
  resourceInventoryVersion: 1;
  agentId: string;
  /** Workflow domain selected for this role mount. */
  domain: string;
  assetCommitId: string;
  parentAssetCommitId?: string;
  mountId: string;
  agentProfile: AgentProfile;
  mountRoot: string;
  runtimeRoots: MountRuntimeRoot[];
  profileReadableRoots: string[];
  profileWritableRoots: string[];
  resourceHash: string;
  generatedAt: string;
  issues: MountMaterializationIssue[];
  assets: Array<{
    id: string;
    type: string;
    sourcePath: string;
    hash: string;
  }>;
  linkedFiles: Array<{
    path: string;
    sourcePath: string;
    hash: string;
  }>;
  generatedFiles: Array<{
    path: string;
    hash: string;
  }>;
  shellTools: Array<{
    id: string;
    exposeAs: string;
    wrapperPath: string;
    command: string;
    required: boolean;
    smoke?: {
      scope: "mount" | "run";
      args: string[];
      marker?: string;
      managedCodebase?: string;
    };
  }>;
  mcpServers: MaterializedMcpServer[];
  customAgents: string[];
  skills: MaterializedSkill[];
  plugins: string[];
}
