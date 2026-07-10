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
import type { WorkerAgent } from "../agent/roles/worker-agent.js";
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
import type { InteractionExitRequestedPayload } from "../interaction/gateway/interaction-events.js";

export class RunManager {
  async startRun(options: ScoutRunOptions): Promise<ScoutRunResult> {
    const interactionPort = options.interactionPort ?? new NoopRuntimeInteractionPort();
    const runId = buildRunId();
    const runtimeLogger = new Logger({
      runId,
      logsRoot: join(options.cwd, "run", runId, "logs"),
    });
    const runStartedAt = Date.now();
    runtimeLogger.info({
      module: "run.lifecycle",
      event: "run_started",
      data: {
        cwd: options.cwd,
      },
    });
    const preparedClients = await runPreparationStage(runtimeLogger, "clients", () =>
      prepareRunClients({
        repoRoot: options.cwd,
        runId,
      })
    );
    const cleanup = new RunCleanup(runtimeLogger);
    cleanup.add("app_server", () => preparedClients.appServerClient.client.close());
    let preparedRun: PreparedRun;
    try {
      preparedRun = await runPreparationStage(runtimeLogger, "environment", () =>
        prepareRunEnvironment({
          repoRoot: options.cwd,
          runId,
          preparedClients,
        })
      );
    } catch (error) {
      await cleanup.run("environment_preparation_failed");
      throw error;
    }
    const eventBus = new InMemoryEventBus();
    const interactionGateway = new InteractionGateway({
      eventBus,
      interactionPort,
      logger: runtimeLogger,
    });
    interactionGateway.start();
    cleanup.add("interaction_gateway", () => interactionGateway.stop());
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
      runtimeLogger.error({
        module: "run.lifecycle",
        event: "run_preparation_failed",
        data: {
          stage: "environment",
          agents: summarizeAgents(preparedRun),
        },
      });
      await cleanup.run("preflight_failed");
      return this.toRunResult(preparedRun, "failed");
    }

    const domain = new ValidationDomain({
      runId: preparedRun.runId,
    });
    let preparedAgents: Awaited<ReturnType<typeof prepareAgents>> | undefined;

    try {
      preparedAgents = await runPreparationStage(runtimeLogger, "agents", () =>
        prepareAgents({
          preparedRun,
          preparedClients,
          repoRoot: options.cwd,
          logger: runtimeLogger,
          eventBus,
          domain,
        })
      );
    } catch (error) {
      eventBus.publish(SystemEvents.interaction.disclosureRequested, {
        level: "error",
        source: "run.manager",
        message: "Scout agent preparation failed.",
        data: {
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        },
      } satisfies RuntimeDisclosureEvent);
      runtimeLogger.error({
        module: "run.lifecycle",
        event: "run_preparation_failed",
        data: {
          stage: "agents",
          error: errorText(error),
        },
      });
      await cleanup.run("agent_preparation_failed");
      return this.toRunResult(preparedRun, "failed");
    }

    const appServer = preparedAgents.appServerClient.client;
    const agentBackend = new AgentBackend({
      runId: preparedRun.runId,
      appServer,
      registry: preparedAgents.registry,
      taskStore: preparedAgents.taskStore,
      eventBus,
      agentProvider: {
        resolveWorker(input): WorkerAgent {
          const agent = preparedAgents.registry.resolveAgent(input.role);
          if (agent.role === ScoutAgentRoles.Coordinator) {
            throw new Error("Coordinator cannot be resolved as a worker.");
          }
          return agent as WorkerAgent;
        },
      },
      logger: runtimeLogger,
      domain,
    });

    let orchestrator: AgentOrchestrator | undefined;
    try {
      await runPreparationStage(runtimeLogger, "runtime", async () => {
        await agentBackend.domain.start?.();
        cleanup.add("domain", () => agentBackend.domain.stop?.());
        orchestrator = new AgentOrchestrator({
          eventBus,
        });
        orchestrator.start();
        cleanup.add("orchestrator", () => orchestrator?.stop());
        cleanup.add("agent_runners", () => {
          for (const agent of Object.values(preparedAgents.agents)) {
            agent.runner.stop("run_cleanup");
          }
        });
      });
      const unsubscribeExitRequested = eventBus.subscribe(
        SystemEvents.interaction.exitRequested,
        async (event) => {
          const payload = event.payload as InteractionExitRequestedPayload;
          runtimeLogger.info({
            module: "run.lifecycle",
            event: "run_exit_requested",
            data: {
              requestedAt: payload.requestedAt,
            },
          });
          await cleanup.run("exit_requested");
        },
      );
      cleanup.add("exit_subscription", unsubscribeExitRequested);
    } catch (error) {
      eventBus.publish(SystemEvents.interaction.disclosureRequested, {
        level: "error",
        source: "run.manager",
        message: "Scout run failed to start.",
        data: {
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        },
      } satisfies RuntimeDisclosureEvent);
      runtimeLogger.error({
        module: "run.lifecycle",
        event: "run_preparation_failed",
        data: {
          stage: "runtime",
          error: errorText(error),
        },
      });
      await cleanup.run("runtime_start_failed");
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
    runtimeLogger.info({
      module: "run.lifecycle",
      event: "run_ready",
      data: {
        durationMs: Math.max(0, Date.now() - runStartedAt),
        agents: Object.keys(preparedAgents.agents),
      },
    });

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
  private readonly handlers: Array<{
    name: string;
    handler: () => void | Promise<void>;
  }> = [];
  private readonly logger: Logger;
  private running?: Promise<void>;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  add(name: string, handler: () => void | Promise<void>): void {
    if (this.running) {
      void Promise.resolve(handler()).catch((error) => this.logError(name, error));
      return;
    }
    this.handlers.push({ name, handler });
  }

  run(reason: string): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runHandlers(reason);
    return this.running;
  }

  private async runHandlers(reason: string): Promise<void> {
    const startedAt = Date.now();
    const handlerCount = this.handlers.length;
    let errorCount = 0;
    this.logger.info({
      module: "run.lifecycle",
      event: "cleanup_started",
      data: {
        reason,
        handlerCount,
      },
    });
    while (this.handlers.length > 0) {
      const entry = this.handlers.pop();
      if (!entry) continue;
      try {
        await entry.handler();
      } catch (error) {
        errorCount += 1;
        this.logError(entry.name, error);
      }
    }
    this.logger.info({
      module: "run.lifecycle",
      event: "cleanup_completed",
      data: {
        reason,
        handlerCount,
        errorCount,
        durationMs: Math.max(0, Date.now() - startedAt),
      },
    });
  }

  private logError(handler: string, error: unknown): void {
    this.logger.error({
      module: "run.lifecycle",
      event: "cleanup_error",
      data: {
        handler,
        error: errorText(error),
      },
    });
  }
}

async function runPreparationStage<T>(
  logger: Logger,
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  logger.info({
    module: "run.lifecycle",
    event: "preparation_stage_started",
    data: { stage },
  });
  try {
    const result = await operation();
    logger.info({
      module: "run.lifecycle",
      event: "preparation_stage_completed",
      data: {
        stage,
        durationMs: Math.max(0, Date.now() - startedAt),
      },
    });
    return result;
  } catch (error) {
    logger.error({
      module: "run.lifecycle",
      event: "preparation_stage_failed",
      data: {
        stage,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: errorText(error),
      },
    });
    throw error;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
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
