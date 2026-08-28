/** Stable repository-relative locations for Codex assets consumed by Scout. */
export const CodexAssetLayout = {
  agentsMd: "agents/AGENTS.md",
  workerAgentsMd: "agents/worker.AGENTS.md",
  customAgentsRoot: "agents",
  baseConfig: "config/base.config.toml",
  mcpServers: "mcp/servers.json",
  shellTools: "tools/shell-tools.json",
  skillsRoot: "skills",
  pluginsRoot: "plugins",
  vendorsRoot: "vendors",
  workflowsRoot: "workflows",
} as const;
