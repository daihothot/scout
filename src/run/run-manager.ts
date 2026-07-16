import { join } from "node:path";
import {
  ScoutAgentRoles,
  type ScoutAgentRole,
} from "../agent/thread/types.js";
import { InMemoryEventBus } from "../core/events/index.js";
import { Logger } from "../core/logging/index.js";
import { ValidationDomain } from "../domain/index.js";
import {
  NoopRuntimeInteractionPort,
  type RuntimeDisclosureEvent,
} from "../interaction/index.js";
import { SystemEvents } from "../system/events/index.js";
import {
  BootAgentBackendStage,
  BootAgentTelemetryStage,
  BootAgentsStage,
  BootClientsStage,
  BootDomainStage,
  BootEnvironmentStage,
  BootExecutor,
  BootInteractionStage,
  BootOrchestratorStage,
  BootRunScopeStage,
} from "./boot/index.js";
import {
  type RunAgentEnvironment,
  type RunEnvironment,
  type ScoutRunOptions,
  type ScoutRunSummary,
} from "./types.js";
import { currentRunScope } from "./run-scope.js";

export class RunManager {
  async startRun(options: ScoutRunOptions): Promise<ScoutRunSummary> {
    const interactionPort = options.interactionPort ?? new NoopRuntimeInteractionPort();
    const runId = buildRunId();
    const runtimeLogger = new Logger({
      runId,
      logsRoot: join(options.cwd, "run", runId, "logs"),
    });
    const runStartedAt = Date.now();
    const eventBus = new InMemoryEventBus();
    const domain = new ValidationDomain();
    runtimeLogger.info({
      module: "run.lifecycle",
      event: "run_started",
      data: { cwd: options.cwd },
    });

    const boot = new BootExecutor({
      runId,
      logger: runtimeLogger,
      onStateChange: (snapshot) => interactionPort.publishBootSnapshot(snapshot),
    });
    const runScopeStage = new BootRunScopeStage({
      runId,
      repoRoot: options.cwd,
      logger: runtimeLogger,
      eventBus,
      interactionPort,
      domain,
      terminate: (reason) => boot.terminate(reason),
    });
    const interactionStage = new BootInteractionStage();
    const clientsStage = new BootClientsStage();
    const environmentStage = new BootEnvironmentStage();
    const domainStage = new BootDomainStage();
    const telemetryStage = new BootAgentTelemetryStage();
    const agentsStage = new BootAgentsStage();
    const agentBackendStage = new BootAgentBackendStage();
    const orchestratorStage = new BootOrchestratorStage();

    boot.registerSerial(
      runScopeStage,
      interactionStage,
      clientsStage,
      environmentStage,
    );
    boot.registerParallel(domainStage, telemetryStage);
    boot.registerSerial(agentsStage);
    boot.registerParallel(agentBackendStage, orchestratorStage);

    try {
      await boot.startup();
    } catch (error) {
      runtimeLogger.error({
        module: "run.lifecycle",
        event: "run_start_failed",
        data: {
          error: errorText(error),
          boot: boot.snapshot(),
        },
      });
      try {
        await interactionPort.disclose({
          level: "error",
          source: "run.boot",
          message: "Scout run failed to start.",
          data: {
            runId,
            error: errorText(error),
          },
        });
      } catch (disclosureError) {
        runtimeLogger.warn({
          module: "interaction.gateway",
          event: "boot_failure_disclosure_failed",
          data: { error: errorText(disclosureError) },
        });
      }
      if (runScopeStage.scopeCreated && runScopeStage.scope.hasEnvironment) {
        return this.toRunSummary(runScopeStage.scope.environment, "failed");
      }
      throw error;
    }

    eventBus.publish(SystemEvents.interaction.disclosureRequested, {
      level: "info",
      source: "run.boot",
      message: "Scout run prepared.",
      data: { runId },
    } satisfies RuntimeDisclosureEvent);
    const scope = currentRunScope();
    runtimeLogger.info({
      module: "run.lifecycle",
      event: "run_ready",
      data: {
        durationMs: Math.max(0, Date.now() - runStartedAt),
        agents: scope.agentRegistry.listAgents().map((agent) => agent.agentId),
      },
    });

    return this.toRunSummary(scope.environment, "passed");
  }

  private toRunSummary(
    environment: RunEnvironment,
    status: ScoutRunSummary["status"],
  ): ScoutRunSummary {
    const coordinator = environment.agents[ScoutAgentRoles.Coordinator];
    return {
      status,
      runId: environment.contextBundle.runId,
      coordinatorMountRoot: coordinator.mount.mountRoot,
      rootAccess: environment.rootAccess,
      agents: mapBootAgents(environment, (agent) => ({
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

export async function startRun(options: ScoutRunOptions): Promise<ScoutRunSummary> {
  return new RunManager().startRun(options);
}

function mapBootAgents<T>(
  environment: RunEnvironment,
  mapper: (agent: RunAgentEnvironment) => T,
): Record<ScoutAgentRole, T> {
  return Object.fromEntries(
    Object.entries(environment.agents).map(([role, agent]) => [
      role,
      mapper(agent),
    ]),
  ) as Record<ScoutAgentRole, T>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function buildRunId(): string {
  return `run-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
}
