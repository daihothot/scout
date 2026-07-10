import type { CodexModelConfig } from "../agent-server/codex/model-config.js";

export interface AgentProfilesFile {
  defaults: {
    model: CodexModelConfig;
  };
  profiles: Record<string, AgentProfileDefinition>;
}

export interface AgentProfileDefinition {
  config: string;
  model?: CodexModelConfig;
  skills: string[];
  shellTools?: string[];
  mcpServers: string[];
  plugins: string[];
  trustedRoots?: string[];
  writableRoots?: string[];
}

export interface AgentProfile extends AgentProfileDefinition {
  model: CodexModelConfig;
}

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

export interface ShellToolsFile {
  tools: ShellToolContract[];
}

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

export interface MountMaterializationIssue {
  severity: "error" | "warning";
  code: "shell_tool_unresolved";
  message: string;
  resourceId: string;
  detail?: Record<string, unknown>;
}

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
  skills: string[];
  plugins: string[];
  manifestPath: string;
  resourceHash: string;
}

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
  skills: string[];
  plugins: string[];
  manifestPath: string;
  resourceHash: string;
  createdAt: string;
  status: "materialized" | "preflight_passed" | "preflight_failed";
  preflightRef?: string;
}

export interface MountManifest {
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
  skills: string[];
  plugins: string[];
  workerAgent: string;
  roleAgents: Record<string, string>;
}
