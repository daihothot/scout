import type { CodexAppServerClient } from "../../agent-server/codex/app-server-client.js";
import type { EventBus } from "../../core/events/index.js";
import type { ScoutAgentRole } from "../thread/types.js";
import { ScoutAgentRoles } from "../thread/types.js";
import type { AssignAgentTaskInput } from "../task/types.js";
import type { ScoutDomain } from "../../domain/index.js";
import type { AgentRegistry } from "../core/agent-registry.js";
import type { Logger } from "../../core/logging/index.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import type { AgentTaskStore } from "../task/agent-task-store.js";

export interface AgentProvider {
  getOrCreateWorker(input: {
    role: Exclude<ScoutAgentRole, typeof ScoutAgentRoles.Coordinator>;
    agentId?: string;
  }): ScoutAgent;
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

export type AssignBackendAgentTaskInput = Omit<AssignAgentTaskInput, "taskId" | "subagentType"> & {
  subagentType: Exclude<ScoutAgentRole, typeof ScoutAgentRoles.Coordinator>;
};
