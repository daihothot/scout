/**
 * Persisted mount and preflight facts owned by a run. Commit construction and
 * storage are separate so this contract remains a pure serialized shape.
 */
import type { AgentProfile } from "./profile.js";
import type {
  MaterializedMcpServer,
  ShellToolContract,
} from "./resources.js";
import type { MountMaterializationIssue } from "./mount.js";
import type { ScoutSkillCatalogEntry } from "./skill.js";

/** Persisted mount identity and preflight status written into run artifacts. */
export interface AssetCommit {
  agentId: string;
  agentProfile: AgentProfile;
  assetCommitId: string;
  parentAssetCommitId?: string;
  mountId: string;
  mountRoot: string;
  runRoot: string;
  artifactRoot: string;
  logsRoot: string;
  issues: MountMaterializationIssue[];
  trustedRoots: string[];
  writableRoots: string[];
  shellTools: ShellToolContract[];
  mcpServers: MaterializedMcpServer[];
  customAgents: string[];
  skills: string[];
  skillCatalog: ScoutSkillCatalogEntry[];
  plugins: string[];
  manifestPath: string;
  resourceHash: string;
  createdAt: string;
  status: "materialized" | "preflight_passed" | "preflight_failed";
  preflightRef?: string;
}
