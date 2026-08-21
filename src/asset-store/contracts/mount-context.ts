/**
 * Immutable source, resource, identity, and path facts derived for one role.
 * Builders produce this shape; inspection and mount capabilities consume it.
 */
import type { AgentProfile } from "./profile.js";
import type { McpServersFile, ShellToolContract } from "./resources.js";
import type { ScoutSkillCatalogEntry } from "./skill.js";

/** Complete mount construction context derived before the mount root is touched. */
export interface MountContext {
  scoutRoot: string;
  assetsRoot: string;
  runId: string;
  runRoot: string;
  agentId: string;
  agentRoot: string;
  artifactRoot: string;
  logsRoot: string;
  /** Run-scoped writable temporary directory for this Agent's shell tools. */
  tempRoot: string;
  mountRoot: string;
  agentProfile: AgentProfile;
  profiledMcpServers: McpServersFile;
  profiledShellTools: ShellToolContract[];
  profiledCustomAgentPaths: string[];
  profiledSkillPaths: string[];
  profiledPluginPaths: string[];
  skillCatalog: ScoutSkillCatalogEntry[];
  resourceHash: string;
  assetCommitId: string;
  parentAssetCommitId?: string;
  mountId: string;
  readableRoots: string[];
  writableRoots: string[];
}
