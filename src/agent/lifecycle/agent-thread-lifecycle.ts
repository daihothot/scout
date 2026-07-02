import type { CodexAppServerClient } from "../../agent-server/codex/app-server-client.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import type { AgentThreadSnapshot } from "../model/types.js";
import type { AgentRegistry } from "./agent-registry.js";
import {
  runThreadPreflight,
  type ScoutAgentThreadPreflightSnapshot,
} from "./thread-preflight.js";

export interface AgentThreadLifecycleLogger {
  info(input: unknown): void;
}

export interface AgentThreadLifecycleOptions {
  appServer: CodexAppServerClient;
  registry: AgentRegistry;
  logger: AgentThreadLifecycleLogger;
}

export class AgentThreadLifecycle {
  private readonly appServer: CodexAppServerClient;
  private readonly registry: AgentRegistry;
  private readonly logger: AgentThreadLifecycleLogger;
  private readonly startedAgents = new Map<string, AgentThreadSnapshot>();
  private readonly threadPreflights = new Map<string, ScoutAgentThreadPreflightSnapshot>();

  constructor(options: AgentThreadLifecycleOptions) {
    this.appServer = options.appServer;
    this.registry = options.registry;
    this.logger = options.logger;
  }

  async startWithPreflight(agent: ScoutAgent): Promise<{
    thread: AgentThreadSnapshot;
    preflight: ScoutAgentThreadPreflightSnapshot;
  }> {
    const thread = await agent.start();
    this.registry.bindThread(agent.agentId, thread.threadId);

    const existing = this.threadPreflights.get(thread.threadId);
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
      appServer: this.appServer,
    });
    this.cacheStartedAgent(agent, thread, preflight);
    return {
      thread,
      preflight,
    };
  }

  listStartedAgents(): AgentThreadSnapshot[] {
    return [...this.startedAgents.values()];
  }

  listThreadPreflights(): ScoutAgentThreadPreflightSnapshot[] {
    return [...this.threadPreflights.values()];
  }

  private cacheStartedAgent(
    agent: ScoutAgent,
    thread: AgentThreadSnapshot,
    preflight: ScoutAgentThreadPreflightSnapshot,
  ): void {
    if (this.startedAgents.has(thread.threadId)) return;
    this.startedAgents.set(thread.threadId, thread);
    this.threadPreflights.set(thread.threadId, preflight);
    this.logger.info({
      module: "agent.lifecycle",
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
}
