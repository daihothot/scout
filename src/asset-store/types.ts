import type { CodexModelConfig } from "../agent-server/codex/model-config.js";
import type { ScoutSkillCatalogEntry } from "./assets/skill-catalog.js";

/** Parsed repository profile document containing defaults and named roles. */
export interface AgentProfilesFile {
  defaults: {
    model: CodexModelConfig;
  };
  profiles: Record<string, AgentProfileDefinition>;
}

/** Profile-owned limits, resources, and permission roots before model defaults are applied. */
export interface AgentProfileDefinition {
  config: string;
  multiAgent: boolean;
  maxThreads: number;
  maxDepth: number;
  customAgents: string[];
  model?: CodexModelConfig;
  skills: string[];
  shellTools?: string[];
  mcpServers: string[];
  plugins: string[];
  trustedRoots?: string[];
  writableRoots?: string[];
}

/** Fully normalized profile used by mount construction, including a required model. */
export interface AgentProfile extends AgentProfileDefinition {
  model: CodexModelConfig;
}

/** Repository MCP server contracts selected by an agent profile. */
export interface McpServersFile {
  servers: Record<string, {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    trustedRoots?: string[];
    writableRoots?: string[];
    smoke?: {
      tool: string;
      arguments?: Record<string, unknown>;
    };
  }>;
}

/** MCP contract after command, paths, environment, and wrapper location are resolved. */
export interface MaterializedMcpServer {
  name: string;
  wrapperPath: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  trustedRoots: string[];
  writableRoots: string[];
  smoke?: {
    tool: string;
    arguments?: Record<string, unknown>;
  };
}

/** Top-level shell-tool registry loaded from the asset repository. */
export interface ShellToolsFile {
  tools: ShellToolContract[];
}

/** Declarative shell command contract used to build a mount-local executable wrapper. */
export interface ShellToolContract {
  id: string;
  name: string;
  command: string;
  args?: string[];
  exposeAs: string;
  required: boolean;
  smokeArgs?: string[];
  marker?: string;
}

/** Non-fatal or fatal issue emitted while a mount resource is being materialized. */
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
}

/** Outcome of comparing an existing mount against the current portable context. */
export type MountPreparationDecision = "reused" | "rebuild";

/** Reuse decision plus a diagnostic reason when rebuilding is required. */
export interface MountPreparationInspection {
  decision: MountPreparationDecision;
  reason?: string;
}

/** Filesystem materialization phases reported by the asset store. */
export type MountMaterializationStep =
  | "wipe"
  | "layout"
  | "config"
  | "skills"
  | "plugins"
  | "shell";

/** Mount projection returned after inspection and optional materialization. */
export interface MountPreparationResult {
  mount: CodexMount;
  decision: MountPreparationDecision;
  reason?: string;
}

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

/** Portable manifest used to verify and reconstruct a role mount later. */
export interface MountManifest {
  resourceInventoryVersion?: 1;
  agentId: string;
  assetCommitId: string;
  parentAssetCommitId?: string;
  mountId: string;
  agentProfile: AgentProfile;
  mountRoot: string;
  trustedRoots: string[];
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
    marker?: string;
  }>;
  mcpServers: MaterializedMcpServer[];
  customAgents: string[];
  skills: string[];
  skillCatalog: ScoutSkillCatalogEntry[];
  plugins: string[];
  workerAgent?: string;
  roleAgents: Record<string, string>;
}
