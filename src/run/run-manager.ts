import { join } from "node:path";
import type {
  AssetCommit,
  CodexMount,
} from "../asset-store/index.js";
import type { ScoutAgentRole } from "../agent/model/types.js";
import { ScoutAgentRoles } from "../agent/model/types.js";
import { AgentBuilder } from "../agent/builder/agent-builder.js";
import { AgentBackend } from "../agent/backend/agent-backend.js";
import { AgentRegistry } from "../agent/lifecycle/agent-registry.js";
import { AgentThreadLifecycle } from "../agent/lifecycle/agent-thread-lifecycle.js";
import { AgentOrchestrator } from "../agent/orchestration/agent-orchestrator.js";
import type { ScoutAgent } from "../agent/core/scout-agent.js";
import { AgentTaskStore } from "../agent/task/agent-task-store.js";
import { InMemoryEventBus } from "../core/events/index.js";
import { Logger } from "../core/logging/index.js";
import { ValidationDomain } from "../domain/index.js";
import { NoopRuntimeInteractionPort } from "../interaction/index.js";
import { prepareRunEnvironment, type PreparedRun } from "./run-preparation.js";
import type { CreateCodexAppServerClientOptions } from "../agent-server/codex/app-server-factory.js";
import { buildRunContextBundle } from "./types.js";
import type { ScoutRunOptions, ScoutRunResult } from "./run-types.js";

export class RunManager {
  async prepareRun(options: ScoutRunOptions): Promise<ScoutRunResult> {
    const preparedRun = await prepareRunEnvironment<CreateCodexAppServerClientOptions>({
      repoRoot: options.cwd,
      runId: buildRunId(),
      mcpServerBindings: options.mcpServerBindings,
      createAppServerClient: (clientOptions) => clientOptions,
    });
    return this.toRunResult(preparedRun);
  }

  async startRun(options: ScoutRunOptions): Promise<ScoutRunResult> {
    const interactionPort = options.interactionPort ?? new NoopRuntimeInteractionPort();
    await interactionPort.disclose({
      level: "info",
      source: "run.manager",
      message: "Preparing Scout run.",
    });

    const preparedRun = await prepareRunEnvironment({
      repoRoot: options.cwd,
      runId: buildRunId(),
      mcpServerBindings: options.mcpServerBindings,
    });
    const preparationStatus = runPreparationStatus(preparedRun);
    if (preparationStatus !== "passed") {
      await interactionPort.disclose({
        level: "error",
        source: "run.manager",
        message: "Scout run preparation failed.",
        data: {
          runId: preparedRun.runId,
          agents: summarizeAgents(preparedRun),
        },
      });
      preparedRun.appServerClient.client.close();
      return this.toRunResult(preparedRun, "failed");
    }

    const preparedCoordinator = preparedRun.agents[ScoutAgentRoles.Coordinator];
    const contextBundle = buildRunContextBundle({
      runId: preparedRun.runId,
      assetCommit: preparedCoordinator.assetCommit,
    });
    const runtimeLogger = new Logger({
      runId: preparedRun.runId,
      logsRoot: join(preparedCoordinator.assetCommit.runRoot, "logs"),
    });
    const appServer = preparedRun.appServerClient.client;
    const preparedAgents = mapPreparedAgents(preparedRun, (agent) => ({
      agentMount: agent.mount,
      assetCommit: agent.assetCommit,
    }));
    const domain = new ValidationDomain({
      runId: preparedRun.runId,
    });
    const registry = new AgentRegistry({
      logger: runtimeLogger,
    });
    const lifecycle = new AgentThreadLifecycle({
      appServer,
      registry,
      logger: runtimeLogger,
    });
    const taskStore = new AgentTaskStore();
    const eventBus = new InMemoryEventBus();
    let agentBuilder: AgentBuilder | undefined;
    const agentBackend = new AgentBackend({
      runId: preparedRun.runId,
      ledgerRoot: preparedCoordinator.mount.artifactRoot,
      appServer,
      registry,
      lifecycle,
      taskStore,
      eventBus,
      agentProvider: {
        getOrCreateWorker(input): ScoutAgent {
          if (!agentBuilder) throw new Error("AgentBuilder is not initialized.");
          return agentBuilder.getOrCreateWorker(input);
        },
      },
      logger: runtimeLogger,
      interactionPort,
      domain,
    });
    agentBuilder = new AgentBuilder({
      registry,
      lifecycle,
      domain,
      taskStore,
      runtime: {
        repoRoot: options.cwd,
        appServer,
        contextBundle,
        logger: runtimeLogger,
        eventBus,
      },
      preparedAgents,
    });
    const coordinatorAgent = agentBuilder.buildCoordinator();

    let orchestrationStatus: ScoutRunResult["orchestrationStatus"] = "failed";
    try {
      await agentBackend.domain.start?.();
      await appServer.startSession();
      await coordinatorAgent.startWithPreflight();
      const orchestrator = new AgentOrchestrator({
        coordinator: coordinatorAgent,
        agentBackend,
        eventBus,
        interactionPort,
      });
      const loopResult = await orchestrator.run();
      orchestrationStatus = loopResult.status;
    } finally {
      await agentBackend.domain.stop?.();
      appServer.close();
    }

    return {
      ...this.toRunResult(preparedRun, "passed"),
      orchestrationStatus,
      agentLedgerPath: join(preparedCoordinator.mount.artifactRoot, "agent-ledger.json"),
    };
  }

  private toRunResult(
    preparedRun: PreparedRun<unknown>,
    forcedStatus?: ScoutRunResult["status"],
  ): ScoutRunResult {
    const preparedCoordinator = preparedRun.agents[ScoutAgentRoles.Coordinator];
    return {
      status: forcedStatus ?? runPreparationStatus(preparedRun),
      runId: preparedRun.runId,
      coordinatorMountRoot: preparedCoordinator.mount.mountRoot,
      mcpServerBindings: preparedCoordinator.mount.mcpServerBindings,
      rootAccess: preparedRun.rootAccess,
      agents: mapPreparedAgents(preparedRun, (agent) => ({
        mountId: agent.mount.mountId,
        mountRoot: agent.mount.mountRoot,
        artifactRoot: agent.mount.artifactRoot,
        assetCommitId: agent.assetCommit.assetCommitId,
        assetCommitPath: agent.assetCommitPath,
        preflightStatus: agent.preflight.status,
        preflightPath: agent.preflightPath,
      })),
    };
  }
}

export async function prepareRun(options: ScoutRunOptions): Promise<ScoutRunResult> {
  return new RunManager().prepareRun(options);
}

export async function startRun(options: ScoutRunOptions): Promise<ScoutRunResult> {
  return new RunManager().startRun(options);
}

function runPreparationStatus(preparedRun: PreparedRun<unknown>): ScoutRunResult["status"] {
  return Object.values(preparedRun.agents).every((agent) => agent.assetCommit.status === "preflight_passed")
    ? "passed"
    : "failed";
}

function summarizeAgents(preparedRun: PreparedRun<unknown>): Record<string, unknown> {
  return mapPreparedAgents(preparedRun, (agent) => ({
    preflightStatus: agent.preflight.status,
    assetCommitStatus: agent.assetCommit.status,
    issueCount: agent.mount.issues.length,
  }));
}

function mapPreparedAgents<T>(
  preparedRun: PreparedRun<unknown>,
  mapper: (agent: PreparedRun<unknown>["agents"][ScoutAgentRole]) => T,
): Record<ScoutAgentRole, T> {
  return Object.fromEntries(
    Object.entries(preparedRun.agents).map(([role, agent]) => [
      role,
      mapper(agent),
    ]),
  ) as Record<ScoutAgentRole, T>;
}

function buildRunId(): string {
  return `run-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
}
