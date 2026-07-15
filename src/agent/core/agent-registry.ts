import type { ScoutAgent } from "./scout-agent.js";

export class AgentRegistry {
  private readonly agents = new Map<string, ScoutAgent>();
  private readonly threadIdToAgentId = new Map<string, string>();

  registerAgent(agent: ScoutAgent): ScoutAgent {
    const existing = this.agents.get(agent.agentId);
    if (existing) return existing;
    this.agents.set(agent.agentId, agent);
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
