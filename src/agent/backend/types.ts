import type { CodexAppServerClient } from "../../agent-server/codex/app-server-client.js";
import type { RuntimeInteractionPort } from "../../interaction/index.js";
import type { EventBus } from "../../core/events/index.js";
import type { ScoutAgentThreadPreflightRecord } from "../lifecycle/thread-preflight.js";
import type { AgentThreadRecord, ScoutAgentRole } from "../model/types.js";
import { ScoutAgentRoles } from "../model/types.js";
import type { AgentTaskState, AssignAgentTaskInput } from "../task/types.js";
import type { ScoutDomain } from "../../domain/index.js";
import type { AgentRegistry } from "../lifecycle/agent-registry.js";
import type { AgentThreadLifecycle } from "../lifecycle/agent-thread-lifecycle.js";
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
  ledgerRoot: string;
  appServer: CodexAppServerClient;
  registry: AgentRegistry;
  lifecycle: AgentThreadLifecycle;
  taskStore: AgentTaskStore;
  eventBus: EventBus;
  agentProvider: AgentProvider;
  logger: Logger;
  domain: ScoutDomain;
  interactionPort?: RuntimeInteractionPort;
}

export interface ScoutAgentLedger {
  ledgerVersion: 1;
  runId: string;
  agents: AgentThreadRecord[];
  threadPreflights: ScoutAgentThreadPreflightRecord[];
  tasks: AgentTaskState[];
}

export type AssignBackendAgentTaskInput = Omit<AssignAgentTaskInput, "taskId" | "subagentType"> & {
  subagentType: Exclude<ScoutAgentRole, typeof ScoutAgentRoles.Coordinator>;
};
