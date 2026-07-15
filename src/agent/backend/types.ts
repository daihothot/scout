import type { ScoutAgentRole } from "../thread/types.js";
import { ScoutAgentRoles } from "../thread/types.js";
import type { WorkerAgent } from "../roles/worker-agent.js";

export interface AgentProvider {
  resolveWorker(input: {
    role: Exclude<ScoutAgentRole, typeof ScoutAgentRoles.Coordinator>;
  }): WorkerAgent;
}

export interface AgentBackendOptions {
  agentProvider: AgentProvider;
}
