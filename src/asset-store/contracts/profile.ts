/**
 * Profile declarations selected from the asset repository and normalized for
 * mount construction. Validation and default resolution belong to assets.
 */
import type { CodexModelConfig } from "../../agent-server/codex/model-config.js";
import type { ScoutAgentPhase } from "../../agent/thread/types.js";

/** Fully normalized profile used by mount construction, including a required model. */
export interface AgentProfile {
  config: string;
  multiAgent: boolean;
  maxThreads: number;
  maxDepth: number;
  customAgents: string[];
  model: CodexModelConfig;
  phases: ScoutAgentPhase[];
  shellTools: string[];
  mcpServers: string[];
  plugins: string[];
  readableRoots: string[];
  writableRoots: string[];
}
