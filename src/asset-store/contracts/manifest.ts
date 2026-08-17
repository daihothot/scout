/**
 * Portable manifest persisted beside one role mount. Builders produce this
 * shape and inspectors verify it without adding behavior to the contract.
 */
import type { AgentProfile } from "./profile.js";
import type { MaterializedMcpServer } from "./resources.js";
import type { MountMaterializationIssue } from "./mount.js";
import type { MaterializedSkill } from "./skill.js";

/** Portable manifest used to verify and reconstruct a role mount later. */
export interface MountManifest {
  resourceInventoryVersion: 1;
  agentId: string;
  assetCommitId: string;
  parentAssetCommitId?: string;
  mountId: string;
  agentProfile: AgentProfile;
  mountRoot: string;
  readableRoots: string[];
  writableRoots: string[];
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
    };
  }>;
  mcpServers: MaterializedMcpServer[];
  customAgents: string[];
  skills: MaterializedSkill[];
  plugins: string[];
  workerAgent?: string;
  roleAgents: Record<string, string>;
}
