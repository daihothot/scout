import {
  AgentBuilder,
  type PreparedAgentInputs,
} from "../agent/builder/agent-builder.js";
import { AgentRegistry } from "../agent/core/agent-registry.js";
import type { ScoutAgent } from "../agent/core/scout-agent.js";
import { AgentTaskStore } from "../agent/task/agent-task-store.js";
import {
  ScoutAgentRoles,
  type ScoutAgentRole,
} from "../agent/thread/types.js";
import type { EventBus } from "../core/events/index.js";
import type { Logger } from "../core/logging/index.js";
import type { ScoutDomain } from "../domain/index.js";
import type { CodexAppServerClientBundle } from "../agent-server/codex/app-server-factory.js";
import {
  buildRunContextBundle,
  type RunContextBundle,
} from "./types.js";
import type { PreparedRun } from "./run-env-preparation.js";
import type { PreparedRunClients } from "./run-client-preparation.js";

export interface PreparedAgents {
  contextBundle: RunContextBundle;
  appServerClient: CodexAppServerClientBundle;
  registry: AgentRegistry;
  taskStore: AgentTaskStore;
  agents: Record<ScoutAgentRole, ScoutAgent>;
}

export interface PrepareAgentsOptions {
  preparedRun: PreparedRun;
  preparedClients: PreparedRunClients;
  repoRoot: string;
  logger: Logger;
  eventBus: EventBus;
  domain: ScoutDomain;
}

export async function prepareAgents(options: PrepareAgentsOptions): Promise<PreparedAgents> {
  const appServerClient = options.preparedClients.appServerClient;
  const appServer = appServerClient.client;
  const preparedCoordinator = options.preparedRun.agents[ScoutAgentRoles.Coordinator];
  const contextBundle = buildRunContextBundle({
    runId: options.preparedRun.runId,
    assetCommit: preparedCoordinator.assetCommit,
  });
  const registry = new AgentRegistry({
    logger: options.logger,
  });
  const taskStore = new AgentTaskStore();
  const builder = new AgentBuilder({
    registry,
    domain: options.domain,
    taskStore,
    runtime: {
      repoRoot: options.repoRoot,
      appServer,
      contextBundle,
      logger: options.logger,
      eventBus: options.eventBus,
    },
    preparedAgents: mapPreparedAgentInputs(options.preparedRun),
  });
  const agents = {
    [ScoutAgentRoles.Coordinator]: builder.buildCoordinator(),
    [ScoutAgentRoles.Researcher]: builder.buildWorker(ScoutAgentRoles.Researcher),
    [ScoutAgentRoles.Verifier]: builder.buildWorker(ScoutAgentRoles.Verifier),
    [ScoutAgentRoles.Validator]: builder.buildWorker(ScoutAgentRoles.Validator),
  } satisfies Record<ScoutAgentRole, ScoutAgent>;

  try {
    await Promise.all(Object.values(agents).map((agent) => agent.start()));
  } catch (error) {
    appServer.close();
    throw error;
  }

  return {
    contextBundle,
    appServerClient,
    registry,
    taskStore,
    agents,
  };
}

function mapPreparedAgentInputs(preparedRun: PreparedRun): PreparedAgentInputs {
  return Object.fromEntries(
    Object.entries(preparedRun.agents).map(([role, agent]) => [
      role,
      {
        agentMount: agent.mount,
        assetCommit: agent.assetCommit,
      },
    ]),
  ) as PreparedAgentInputs;
}
