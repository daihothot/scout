/**
 * Profile declarations selected from the asset repository and normalized for
 * mount construction. Validation and default resolution belong to assets.
 */
import type { CodexModelConfig } from "../../agent-server/codex/model-config.js";

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
  readableRoots?: string[];
  writableRoots?: string[];
}

/** Fully normalized profile used by mount construction, including a required model. */
export interface AgentProfile extends AgentProfileDefinition {
  model: CodexModelConfig;
}
