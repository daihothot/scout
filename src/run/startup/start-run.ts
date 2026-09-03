import { join, resolve } from "node:path";
import type { ScoutAgentRole } from "../../agent/thread/types.js";
import { InMemoryEventBus } from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import {
  resolveSynthesisRole,
  Scheduler,
  type GraphState,
} from "../../core/workflow/index.js";
import { AssetStore } from "../../asset-store/index.js";
import { createDomainRuntime } from "../../domain/index.js";
import {
  NoopRuntimeInteractionPort,
  type RuntimeDisclosureEvent,
} from "../../interaction/index.js";
import { loadScoutConfig } from "../../system/config/index.js";
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
  const scoutRoot = resolve(options.cwd);
  const scoutConfig = loadScoutConfig(scoutRoot);
  const eventBus = new InMemoryEventBus();
  const graphState = new AssetStore().buildWorkflow(scoutRoot, scoutConfig.workflow.profile);
  const scheduler = new Scheduler(
    graphState,
    eventBus,
  );
  const runRoot = join(scoutRoot, "run", runId);
  const runtimeLogger = new Logger({
    runId,
    logsRoot: join(runRoot, "logs"),
  });
  const runStartedAt = Date.now();
  const domain = await createDomainRuntime(graphState.domain);
  const journal = RunJournal.create({ runId, runRoot });
  const manifestStore = new RunManifestStore(runRoot);
  runtimeLogger.info({
    module: "run.lifecycle",
    event: "run_started",
    message: `Created Scout run ${runId} in ${scoutRoot}.`,
    data: { cwd: scoutRoot },
  });

  const executor = new RunStageExecutor({
    runId,
    logger: runtimeLogger,
    onStateChange: (snapshot) => interactionPort.publishRunLifecycleSnapshot(snapshot),
  });
  const runScope = new RunScope({
    runId,
    scoutRoot,
    runRoot,
    logger: runtimeLogger,
    eventBus,
    scheduler,
    interactionPort,
    domain,
    scoutConfig,
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
      message: `Scout run ${runId} failed during startup.`,
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
        message: `Failed to disclose the startup failure for Scout run ${runId}.`,
        data: { error: errorText(disclosureError) },
      });
    }
    if (runScopeStage.scopeCreated && runScopeStage.scope.hasEnvironment) {
      return toRunSummary(
        runScopeStage.scope.environment,
        runScopeStage.scope.scheduler.snapshot(),
        "failed",
      );
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
      message: `Scout run ${runId} started but its ready state could not be persisted.`,
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
    message: `Scout run ${runId} is ready with ${scope.agentRegistry.listAgents().length} agents.`,
    data: {
      durationMs: Math.max(0, Date.now() - runStartedAt),
      agents: scope.agentRegistry.listAgents().map((agent) => agent.agentId),
    },
  });

  return toRunSummary(scope.environment, scope.scheduler.snapshot(), "passed");
}

function toRunSummary(
  environment: RunEnvironment,
  graphState: GraphState,
  status: ScoutRunSummary["status"],
): ScoutRunSummary {
  const coordinator = environment.agents[resolveSynthesisRole(graphState).name];
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
