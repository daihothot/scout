export const CodexAssetLayout = {
  agentsMd: "agents/AGENTS.md",
  agentProfiles: "agents/agent-profiles.json",
  workerAgent: "agents/worker.AGENTS.md",
  baseConfig: "config/base.config.toml",
  mcpServers: "mcp/servers.json",
  shellTools: "tools/shell-tools.json",
  skillsRoot: "skills",
  pluginsRoot: "plugins",
  vendorsRoot: "vendors",
} as const;

export function roleAgentPath(agentId: string): string {
  return `agents/${agentId}.AGENTS.md`;
}
