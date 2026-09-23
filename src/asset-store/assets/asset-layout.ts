/** Stable repository-relative locations for resources owned by Scout. */
export const ScoutAssetLayout = {
  agentsMd: "agents/AGENTS.md",
  coordinatorAgentsMd: "agents/coordinator.AGENTS.md",
  workerAgentsMd: "agents/worker.AGENTS.md",
  mcpServers: "mcp/servers.json",
  shellTools: "tools/shell-tools.json",
  skillsRoot: "skills",
  pluginsRoot: "plugins",
  vendorsRoot: "vendors",
  workflowsRoot: "workflows",
} as const;

/** Codex-native resources projected by the Codex Agent Runtime adapter. */
export const CodexAgentRuntimeAssetLayout = {
  root: "agent-runtimes/codex",
  customAgentsRoot: "agents",
  pluginOverlay: ".codex",
} as const;
