import type { CodexAppServerClient } from "../../agent-server/codex/app-server-client.js";
import type { EventBus } from "../../core/events/index.js";
import type { ScoutAgentRole } from "../thread/types.js";
import { ScoutAgentRoles } from "../thread/types.js";
import type { ScoutDomain } from "../../domain/index.js";
import type { AgentRegistry } from "../core/agent-registry.js";
import type { Logger } from "../../core/logging/index.js";
import type { AgentTaskStore } from "../task/agent-task-store.js";
import type { WorkerAgent } from "../roles/worker-agent.js";

export interface AgentProvider {
  resolveWorker(input: {
    role: Exclude<ScoutAgentRole, typeof ScoutAgentRoles.Coordinator>;
  }): WorkerAgent;
}

export interface AgentBackendOptions {
  runId: string;
  appServer: CodexAppServerClient;
  registry: AgentRegistry;
  taskStore: AgentTaskStore;
  eventBus: EventBus;
  agentProvider: AgentProvider;
  logger: Logger;
  domain: ScoutDomain;
}
