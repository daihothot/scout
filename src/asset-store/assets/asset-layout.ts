/** Stable repository-relative locations for Codex assets consumed by Scout. */
export const CodexAssetLayout = {
  agentsMd: "agents/AGENTS.md",
  agentProfiles: "agents/agent-profiles.json",
  workerAgent: "agents/worker.AGENTS.md",
  customAgentsRoot: "agents",
  baseConfig: "config/base.config.toml",
  mcpServers: "mcp/servers.json",
  shellTools: "tools/shell-tools.json",
  skillsRoot: "skills",
  pluginsRoot: "plugins",
  vendorsRoot: "vendors",
} as const;

/** Builds the repository-relative AGENTS file path for one role identifier. */
export function roleAgentPath(agentId: string): string {
  return `agents/${agentId}.AGENTS.md`;
}
