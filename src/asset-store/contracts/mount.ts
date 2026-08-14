/**
 * Effective runtime mount returned to run and agent layers. Construction,
 * inspection, and persistence are intentionally outside this contract.
 */
import type { AgentProfile } from "./profile.js";
import type {
  MaterializedMcpServer,
  ShellToolContract,
} from "./resources.js";
import type { ScoutSkillCatalogEntry } from "./skill.js";

/** Non-fatal or fatal issue retained on the effective mount projection. */
export interface MountMaterializationIssue {
  severity: "error" | "warning";
  code: "shell_tool_unresolved";
  message: string;
  resourceId: string;
  detail?: Record<string, unknown>;
}

/** Effective runtime paths, resources, identity, and diagnostics for one role mount. */
export interface CodexMount {
  agentId: string;
  agentProfile: AgentProfile;
  assetCommitId: string;
  parentAssetCommitId?: string;
  mountId: string;
  scoutRoot: string;
  mountRoot: string;
  runRoot: string;
  artifactRoot: string;
  logsRoot: string;
  issues: MountMaterializationIssue[];
  readableRoots: string[];
  writableRoots: string[];
  shellTools: ShellToolContract[];
  mcpServers: MaterializedMcpServer[];
  customAgents: string[];
  skills: string[];
  skillCatalog: ScoutSkillCatalogEntry[];
  plugins: string[];
  manifestPath: string;
  resourceHash: string;
}
