import type { AssetCommit, CodexMount } from "../../asset-store/index.js";
import {
  ScoutAgent,
  type ScoutAgentEvent,
  type ScoutAgentOptions,
} from "../scout-agent.js";
import {
  runThreadPreflight,
  type ScoutAgentThreadPreflightRecord,
} from "./thread-preflight.js";
import { ResearcherAgent } from "../roles/researcher-agent.js";
import { ValidatorAgent } from "../roles/validator-agent.js";
import { VerifierAgent } from "../roles/verifier-agent.js";
import type { AgentThreadRecord, ScoutAgentRole } from "../types.js";
import { ScoutAgentRoles } from "../types.js";

export interface AgentRegistryOptions {
  options: ScoutAgentOptions;
  agentMounts?: Partial<Record<ScoutAgentRole, CodexMount>>;
  agentAssetCommits?: Partial<Record<ScoutAgentRole, AssetCommit>>;
  onAgentEvent(event: ScoutAgentEvent): void;
  onAgentStarted?(input: {
    agent: ScoutAgent;
    thread: AgentThreadRecord;
    preflight: ScoutAgentThreadPreflightRecord;
  }): void;
}

export class AgentRegistry {
  private readonly options: ScoutAgentOptions;
  private readonly agentMounts: Partial<Record<ScoutAgentRole, CodexMount>>;
  private readonly agentAssetCommits: Partial<Record<ScoutAgentRole, AssetCommit>>;
  private readonly onAgentEvent: (event: ScoutAgentEvent) => void;
  private readonly onAgentStarted?: NonNullable<AgentRegistryOptions["onAgentStarted"]>;
  private readonly agents = new Map<string, ScoutAgent>();
  private readonly threadIdToAgentId = new Map<string, string>();
  private readonly startedAgents: AgentThreadRecord[] = [];
  private readonly threadPreflights: ScoutAgentThreadPreflightRecord[] = [];

  constructor(options: AgentRegistryOptions) {
    this.options = options.options;
    this.agentMounts = options.agentMounts ?? {};
    this.agentAssetCommits = options.agentAssetCommits ?? {};
    this.onAgentEvent = options.onAgentEvent;
    this.onAgentStarted = options.onAgentStarted;
  }

  registerAgent(agent: ScoutAgent): ScoutAgent {
    const existing = this.agents.get(agent.agentId);
    if (existing) return existing;
    agent.setEventHandler(this.onAgentEvent);
    agent.setThreadPreflightRunner((target) => this.startAgentWithPreflight(target));
    this.agents.set(agent.agentId, agent);
    this.options.logger.info({
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

  async startAgentWithPreflight(agent: ScoutAgent): Promise<{
    thread: AgentThreadRecord;
    preflight: ScoutAgentThreadPreflightRecord;
  }> {
    const thread = await agent.start();
    const existing = this.threadPreflights.find((item) => item.threadId === thread.threadId);
    if (existing) {
      return {
        thread,
        preflight: existing,
      };
    }
    const preflight = await runThreadPreflight({
      agentId: agent.agentId,
      thread,
      mount: agent.mount,
      appServer: this.options.appServer,
    });
    this.trackStartedAgent(agent, thread, preflight);
    this.onAgentStarted?.({
      agent,
      thread,
      preflight,
    });
    return {
      thread,
      preflight,
    };
  }

  trackStartedAgent(
    agent: ScoutAgent,
    thread: AgentThreadRecord,
    preflight: ScoutAgentThreadPreflightRecord,
  ): void {
    this.agents.set(agent.agentId, agent);
    this.threadIdToAgentId.set(thread.threadId, agent.agentId);
    if (!this.startedAgents.some((item) => item.threadId === thread.threadId)) {
      this.startedAgents.push(thread);
      this.threadPreflights.push(preflight);
    }
    this.options.logger.info({
      module: "agent.registry",
      event: "agent_thread_started",
      agentId: agent.agentId,
      data: {
        threadId: thread.threadId,
        role: thread.role,
        phases: thread.phases,
        preflightStatus: preflight.result.status,
      },
    });
  }

  resolveToolCaller(threadId: string): ScoutAgent | undefined {
    return this.resolveAgentByThreadId(threadId);
  }

  resolveAgentByThreadId(threadId: string): ScoutAgent | undefined {
    const agentId = this.threadIdToAgentId.get(threadId);
    return agentId ? this.agents.get(agentId) : undefined;
  }

  resolveAgent(agentIdOrThreadId: string): ScoutAgent {
    const direct = this.agents.get(agentIdOrThreadId);
    if (direct) return direct;
    const agentId = this.threadIdToAgentId.get(agentIdOrThreadId);
    if (agentId) {
      const agent = this.agents.get(agentId);
      if (agent) return agent;
    }
    throw new Error(`Unknown agent: ${agentIdOrThreadId}`);
  }

  getOrCreateAgentForRole(role: Exclude<ScoutAgentRole, typeof ScoutAgentRoles.Coordinator>): ScoutAgent {
    const existing = this.agents.get(role);
    if (existing) return existing;
    return this.registerAgent(this.createAgentForRole(role));
  }

  listAgents(): ScoutAgent[] {
    return [...this.agents.values()];
  }

  listStartedAgents(): AgentThreadRecord[] {
    return [...this.startedAgents];
  }

  listThreadPreflights(): ScoutAgentThreadPreflightRecord[] {
    return [...this.threadPreflights];
  }

  private createAgentForRole(role: Exclude<ScoutAgentRole, typeof ScoutAgentRoles.Coordinator>): ScoutAgent {
    const agentId = role;
    const agentMount = this.agentMounts[role];
    const agentAssetCommit = this.agentAssetCommits[role];
    if (!agentMount || !agentAssetCommit) {
      throw new Error(`Missing prepared mount or asset commit for agent ${role}.`);
    }
    const options = {
      ...this.options,
      agentId,
      agentMount,
      assetCommit: agentAssetCommit,
    };
    if (role === ScoutAgentRoles.Researcher) {
      return new ResearcherAgent(options);
    }
    if (role === ScoutAgentRoles.Validator) {
      return new ValidatorAgent(options);
    }
    return new VerifierAgent(options);
  }
}
