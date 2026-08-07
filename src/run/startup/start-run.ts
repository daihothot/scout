import { join, resolve } from "node:path";
import {
  ScoutAgentRoles,
  type ScoutAgentRole,
} from "../../agent/thread/types.js";
import { InMemoryEventBus } from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import { ValidationDomain } from "../../domain/index.js";
import {
  NoopRuntimeInteractionPort,
  type RuntimeDisclosureEvent,
} from "../../interaction/index.js";
import { SystemEvents } from "../../system/events/index.js";
import { RunJournal } from "../journal/index.js";
import { RunEvents } from "../events/index.js";
import { RunManifestStore } from "../persistence/index.js";
import {
  type RunAgentEnvironment,
  type RunEnvironment,
  type ScoutRunOptions,
  type ScoutRunSummary,
} from "../types.js";
import {
  currentRunScope,
  RunScope,
} from "../run-scope.js";
import {
  RunStageExecutor,
} from "../lifecycle/index.js";
import { StartRunStageAssembly } from "./start-run-stage-assembly.js";

/** Creates a run scope, executes startup stages, and returns its persisted summary. */
export async function startRun(
  options: ScoutRunOptions,
): Promise<ScoutRunSummary> {
  const interactionPort = options.interactionPort ?? new NoopRuntimeInteractionPort();
  const runId = buildRunId();
  const repoRoot = resolve(options.cwd);
  const runRoot = join(repoRoot, "run", runId);
  const runtimeLogger = new Logger({
    runId,
    logsRoot: join(runRoot, "logs"),
  });
  const runStartedAt = Date.now();
  const eventBus = new InMemoryEventBus();
  const domain = new ValidationDomain();
  const journal = RunJournal.create({ runId, runRoot });
  const manifestStore = new RunManifestStore(runRoot);
  runtimeLogger.info({
    module: "run.lifecycle",
    event: "run_started",
    data: { cwd: repoRoot },
  });

  const executor = new RunStageExecutor({
    runId,
    logger: runtimeLogger,
    onStateChange: (snapshot) => interactionPort.publishRunLifecycleSnapshot(snapshot),
  });
  const runScope = new RunScope({
    runId,
    repoRoot,
    logger: runtimeLogger,
    eventBus,
    interactionPort,
    domain,
    journal,
    manifestStore,
    terminate: (reason) => executor.terminate(reason),
  });
  const assembly = new StartRunStageAssembly({
    executor,
    runScope,
  });
  const runScopeStage = assembly.runScopeStage;

  try {
    await executor.startup();
  } catch (error) {
    runtimeLogger.error({
      module: "run.lifecycle",
      event: "run_start_failed",
      data: {
        error: errorText(error),
        lifecycle: executor.snapshot(),
      },
    });
    try {
      await interactionPort.disclose({
        level: "error",
        source: "run.start",
        message: "Scout run failed to start.",
        data: {
          runId,
          error: errorText(error),
        },
      });
    } catch (disclosureError) {
      runtimeLogger.warn({
        module: "interaction.gateway",
        event: "start_failure_disclosure_failed",
        data: { error: errorText(disclosureError) },
      });
    }
    if (runScopeStage.scopeCreated && runScopeStage.scope.hasEnvironment) {
      return toRunSummary(runScopeStage.scope.environment, "failed");
    }
    throw error;
  }

  try {
    const scope = currentRunScope();
    const readyAt = new Date().toISOString();
    scope.eventBus.publish(RunEvents.runtime.ready, {
      mode: "start",
      readyAt,
    }, {
      occurredAt: readyAt,
    });
    scope.manifestStore.update((manifest) => ({
      ...manifest,
      runtime: {
        status: "ready",
        mode: "start",
        processId: process.pid,
      },
      checkpointSeq: scope.journal.lastSeq,
    }));
  } catch (error) {
    await executor.terminate("startup_failed");
    runtimeLogger.error({
      module: "run.lifecycle",
      event: "run_ready_commit_failed",
      data: { error: errorText(error) },
    });
    throw error;
  }
  const scope = currentRunScope();
  scope.eventBus.publish(SystemEvents.interaction.disclosureRequested, {
    level: "info",
    source: "run.start",
    message: "Scout run prepared.",
    data: { runId },
  } satisfies RuntimeDisclosureEvent);
  scope.logger.info({
    module: "run.lifecycle",
    event: "run_ready",
    data: {
      durationMs: Math.max(0, Date.now() - runStartedAt),
      agents: scope.agentRegistry.listAgents().map((agent) => agent.agentId),
    },
  });

  return toRunSummary(scope.environment, "passed");
}

function toRunSummary(
  environment: RunEnvironment,
  status: ScoutRunSummary["status"],
): ScoutRunSummary {
  const coordinator = environment.agents[ScoutAgentRoles.Coordinator];
  return {
    status,
    runId: environment.contextBundle.runId,
    coordinatorMountRoot: coordinator.mount.mountRoot,
    rootAccess: environment.rootAccess,
    agents: mapAgents(environment, (agent) => ({
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

function mapAgents<T>(
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
