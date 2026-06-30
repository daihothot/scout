import type { ScoutAgent } from "../core/scout-agent.js";

export interface AgentRegistryLogger {
  info(input: unknown): void;
}

export interface AgentRegistryOptions {
  logger?: AgentRegistryLogger;
}

export class AgentRegistry {
  private readonly logger?: AgentRegistryLogger;
  private readonly agents = new Map<string, ScoutAgent>();
  private readonly threadIdToAgentId = new Map<string, string>();

  constructor(options: AgentRegistryOptions = {}) {
    this.logger = options.logger;
  }

  registerAgent(agent: ScoutAgent): ScoutAgent {
    const existing = this.agents.get(agent.agentId);
    if (existing) return existing;
    this.agents.set(agent.agentId, agent);
    this.logger?.info({
      module: "agent.registry",
      event: "agent_registered",
      agentId: agent.agentId,
      data: {
        role: agent.role,
        phases: agent.phases,
      },
    });
    return agent;
  }

  bindThread(agentId: string, threadId: string): void {
    this.resolveAgent(agentId);
    this.threadIdToAgentId.set(threadId, agentId);
  }

  resolveToolCaller(threadId: string): ScoutAgent | undefined {
    return this.resolveAgentByThreadId(threadId);
  }

  resolveAgentByThreadId(threadId: string): ScoutAgent | undefined {
    const agentId = this.threadIdToAgentId.get(threadId);
    return agentId ? this.agents.get(agentId) : undefined;
  }

  findAgent(agentIdOrThreadId: string): ScoutAgent | undefined {
    const direct = this.agents.get(agentIdOrThreadId);
    if (direct) return direct;
    const agentId = this.threadIdToAgentId.get(agentIdOrThreadId);
    return agentId ? this.agents.get(agentId) : undefined;
  }

  resolveAgent(agentIdOrThreadId: string): ScoutAgent {
    const agent = this.findAgent(agentIdOrThreadId);
    if (agent) return agent;
    throw new Error(`Unknown agent: ${agentIdOrThreadId}`);
  }

  listAgents(): ScoutAgent[] {
    return [...this.agents.values()];
  }
}
