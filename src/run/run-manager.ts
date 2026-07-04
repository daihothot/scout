import { join } from "node:path";
import type {
  AssetCommit,
  CodexMount,
} from "../asset-store/index.js";
import type { ScoutAgentRole } from "../agent/thread/types.js";
import { ScoutAgentRoles } from "../agent/thread/types.js";
import { AgentBackend } from "../agent/backend/agent-backend.js";
import { AgentOrchestrator } from "../agent/orchestration/agent-orchestrator.js";
import type { ScoutAgent } from "../agent/core/scout-agent.js";
import { InMemoryEventBus } from "../core/events/index.js";
import { SystemEvents } from "../system/events/index.js";
import { Logger } from "../core/logging/index.js";
import { ValidationDomain } from "../domain/index.js";
import {
  InteractionGateway,
  NoopRuntimeInteractionPort,
  type RuntimeDisclosureEvent,
} from "../interaction/index.js";
import { prepareRunClients } from "./run-client-preparation.js";
import { prepareRunEnvironment, type PreparedRun } from "./run-env-preparation.js";
import { prepareAgents } from "./run-agent-preparation.js";
import {
  type ScoutRunOptions,
  type ScoutRunResult,
} from "./types.js";

export class RunManager {
  async startRun(options: ScoutRunOptions): Promise<ScoutRunResult> {
    const interactionPort = options.interactionPort ?? new NoopRuntimeInteractionPort();
    const runId = buildRunId();
    const runtimeLogger = new Logger({
      runId,
      logsRoot: join(options.cwd, "run", runId, "logs"),
    });
    const preparedClients = await prepareRunClients({
      repoRoot: options.cwd,
      runId,
    });
    let preparedRun: PreparedRun;
    try {
      preparedRun = await prepareRunEnvironment({
        repoRoot: options.cwd,
        runId,
        preparedClients,
      });
    } catch (error) {
      preparedClients.appServerClient.client.close();
      throw error;
    }
    const eventBus = new InMemoryEventBus();
    const interactionGateway = new InteractionGateway({
      eventBus,
      interactionPort,
    });
    interactionGateway.start();
    eventBus.publish(SystemEvents.interaction.disclosureRequested, {
      level: "info",
      source: "run.manager",
      message: "Preparing Scout run.",
    } satisfies RuntimeDisclosureEvent);
    const preparationStatus = runPreparationStatus(preparedRun);
    if (preparationStatus !== "passed") {
      eventBus.publish(SystemEvents.interaction.disclosureRequested, {
        level: "error",
        source: "run.manager",
        message: "Scout run preparation failed.",
        data: {
          runId: preparedRun.runId,
          agents: summarizeAgents(preparedRun),
        },
      } satisfies RuntimeDisclosureEvent);
      interactionGateway.stop();
      preparedClients.appServerClient.client.close();
      return this.toRunResult(preparedRun, "failed");
    }

    const domain = new ValidationDomain({
      runId: preparedRun.runId,
    });
    let preparedAgents: Awaited<ReturnType<typeof prepareAgents>> | undefined;

    try {
      preparedAgents = await prepareAgents({
        preparedRun,
        preparedClients,
        repoRoot: options.cwd,
        logger: runtimeLogger,
        eventBus,
        domain,
      });
    } catch (error) {
      eventBus.publish(SystemEvents.interaction.disclosureRequested, {
        level: "error",
        source: "run.manager",
        message: "Scout agent preparation failed.",
        data: {
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        },
      } satisfies RuntimeDisclosureEvent);
      interactionGateway.stop();
      preparedClients.appServerClient.client.close();
      return this.toRunResult(preparedRun, "failed");
    }

    const appServer = preparedAgents.appServerClient.client;
    const cleanup = new RunCleanup();
    cleanup.add(() => appServer.close());
    const agentBackend = new AgentBackend({
      runId: preparedRun.runId,
      appServer,
      registry: preparedAgents.registry,
      taskStore: preparedAgents.taskStore,
      eventBus,
      agentProvider: {
        resolveWorker(input): ScoutAgent {
          return preparedAgents.registry.resolveAgent(input.role);
        },
      },
      logger: runtimeLogger,
      domain,
    });

    let orchestrator: AgentOrchestrator | undefined;
    try {
      await agentBackend.domain.start?.();
      cleanup.add(() => agentBackend.domain.stop?.());
      orchestrator = new AgentOrchestrator({
        eventBus,
      });
      orchestrator.start();
      cleanup.add(() => orchestrator?.stop());
      cleanup.add(() => {
        for (const agent of Object.values(preparedAgents.agents)) {
          agent.runner.stop("run_cleanup");
        }
      });
      const unsubscribeExitRequested = eventBus.subscribe(
        SystemEvents.interaction.exitRequested,
        async () => cleanup.run(),
      );
      cleanup.add(unsubscribeExitRequested);
      cleanup.add(() => interactionGateway.stop());
    } catch (error) {
      await cleanup.run();
      eventBus.publish(SystemEvents.interaction.disclosureRequested, {
        level: "error",
        source: "run.manager",
        message: "Scout run failed to start.",
        data: {
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        },
      } satisfies RuntimeDisclosureEvent);
      return this.toRunResult(preparedRun, "failed");
    }

    eventBus.publish(SystemEvents.interaction.disclosureRequested, {
      level: "info",
      source: "run.manager",
      message: "Scout run prepared.",
      data: {
        runId: preparedRun.runId,
      },
    } satisfies RuntimeDisclosureEvent);

    return this.toRunResult(preparedRun, "passed");
  }

  private toRunResult(
    preparedRun: PreparedRun,
    forcedStatus?: ScoutRunResult["status"],
  ): ScoutRunResult {
    const preparedCoordinator = preparedRun.agents[ScoutAgentRoles.Coordinator];
    return {
      status: forcedStatus ?? runPreparationStatus(preparedRun),
      runId: preparedRun.runId,
      coordinatorMountRoot: preparedCoordinator.mount.mountRoot,
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

class RunCleanup {
  private readonly handlers: Array<() => void | Promise<void>> = [];
  private started = false;

  add(handler: () => void | Promise<void>): void {
    if (this.started) {
      void Promise.resolve(handler()).catch(() => undefined);
      return;
    }
    this.handlers.push(handler);
  }

  async run(): Promise<void> {
    if (this.started) return;
    this.started = true;
    while (this.handlers.length > 0) {
      const handler = this.handlers.pop();
      if (!handler) continue;
      await Promise.resolve(handler()).catch(() => undefined);
    }
  }
}

export async function startRun(options: ScoutRunOptions): Promise<ScoutRunResult> {
  return new RunManager().startRun(options);
}

function runPreparationStatus(preparedRun: PreparedRun): ScoutRunResult["status"] {
  return Object.values(preparedRun.agents).every((agent) => agent.assetCommit.status === "preflight_passed")
    ? "passed"
    : "failed";
}

function summarizeAgents(preparedRun: PreparedRun): Record<string, unknown> {
  return mapPreparedAgents(preparedRun, (agent) => ({
    preflightStatus: agent.preflight.status,
    assetCommitStatus: agent.assetCommit.status,
    issues: agent.mount.issues.map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      resourceId: issue.resourceId,
    })),
  }));
}

function mapPreparedAgents<T>(
  preparedRun: PreparedRun,
  mapper: (agent: PreparedRun["agents"][ScoutAgentRole]) => T,
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
