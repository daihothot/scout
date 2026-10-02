import { statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { runPaths, scoutJournalPaths, scoutRunRoot } from "../../core/path.js";
import type { ScoutAgentRole } from "../../agent/thread/types.js";
import { InMemoryEventBus } from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import { resolveSynthesisRole, projectWorkflowData, Workflow, WorkflowEvents, type GraphData, type WorkflowResumeInput } from "../../core/workflow/index.js";
import { ScoutBenchmarks } from "../../core/benchmarks/index.js";
import { Benchmarks } from "../../core/benchmarks/index.js";
import { ScoutRecordObject } from "../../core/record/scout-record-object.js";
import type { ScoutRecord } from "../../core/record/scout-record.js";
import { AssetStore } from "../../asset-store/index.js";
import {
  NoopRuntimeInteractionPort,
  type RuntimeDisclosureEvent,
} from "../../interaction/index.js";
import { loadScoutConfig } from "../../system/config/index.js";
import { SystemEvents } from "../../system/events/index.js";
import { RunEvents } from "../events/index.js";
import { RunManifestStore } from "../persistence/index.js";
import {
  currentRunScope,
  RunScope,
} from "../run-scope.js";
import {
  RunStageExecutor,
} from "../lifecycle/index.js";
import type {
  RunAgentEnvironment,
  RunEnvironment,
  ResumeRunOptions,
  ScoutRunSummary,
} from "../types.js";
import { projectGraphData } from "../../core/workflow/projector/graph-projector.js";
import { ResumeRunStageAssembly } from "./resume-run-stage-assembly.js";
import { PrepareEnvironmentStage } from "../startup/stages/prepare-environment-stage.js";
import { RestoreEnvironmentStage, ResumeClientsStage } from "./stages/index.js";

/**
 * Reopens a persisted run and executes its resume lifecycle.
 *
 * The selected journal must belong to this run. A missing benchmark target
 * leaves the Run without an active Workflow; other journal failures are fatal.
 * Stage-owned restoration rebuilds runtime resources, then activation
 * re-enables any work represented by the selected Workflow's journal projection.
 */
export async function resumeRun(
  options: ResumeRunOptions,
): Promise<ScoutRunSummary> {
  const interactionPort = options.interactionPort ?? new NoopRuntimeInteractionPort();
  const runRoot = resolveRunRoot(options.cwd, options.run);
  const manifestStore = new RunManifestStore(runRoot);
  const manifest = manifestStore.read();
  const runDirectory = dirname(runRoot);
  if (basename(runRoot) !== manifest.runId || basename(runDirectory) !== "run") {
    throw new Error(
      `Run directory ${runRoot} must be <ScoutRoot>/run/${manifest.runId}.`,
    );
  }
  const scoutRoot = dirname(runDirectory);
  const benchmarks = new ScoutBenchmarks(new Benchmarks(runRoot));
  const selectedWorkflow = benchmarks.resolve("currentWorkflow");
  const selectedWorkflowId = benchmarks.read()?.currentWorkflow;
  const journalRoot = selectedWorkflow?.journalRoot;
  const journalPath = journalRoot ? scoutJournalPaths(journalRoot).path : undefined;
  let persistedEvents: ScoutRecord[] | undefined;
  try {
    if (journalPath) persistedEvents = ScoutRecordObject.readFile(journalPath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  if (persistedEvents) {
    const runCreated = persistedEvents.find((event) => RunEvents.run.created.is(event));
    if (!runCreated || !RunEvents.run.created.is(runCreated)) {
      throw new Error(`Cannot resume ${manifest.runId}: Workflow ${selectedWorkflowId} is missing run.created.`);
    }
    if (runCreated.payload.runId !== manifest.runId) {
      throw new Error(
        `Cannot resume ${manifest.runId}: Workflow ${selectedWorkflowId}`
        + ` belongs to Run ${runCreated.payload.runId}.`,
      );
    }
  }
  // An absent index is only an unfinished bootstrap when the selected journal
  // proves that no Agent or phase execution has begun. Never rebuild an
  // established runtime from missing metadata or missing evidence.
  const initializeEnvironment = manifest.agents === undefined;
  if (initializeEnvironment) {
    if ((selectedWorkflowId !== undefined && !persistedEvents) || persistedEvents?.some((event) => event.key.scope === "agent"
      || WorkflowEvents.workflow.advanced.is(event)
      || WorkflowEvents.workflow.completed.is(event))) {
      throw new Error(
        `Cannot initialize Run ${manifest.runId}: its environment index is missing`
        + " and its Workflow evidence does not prove an unfinished bootstrap.",
      );
    }
  }
  const assetStore = new AssetStore();
  const config = assetStore.config(scoutRoot);
  const scoutConfig = loadScoutConfig(config);
  const eventBus = new InMemoryEventBus();
  const selectedProfile = assetStore.buildWorkflow(scoutRoot, scoutConfig.workflow.profile);
  const workflow = new Workflow(selectedProfile);
  let recovery: WorkflowResumeInput | undefined;
  if (persistedEvents) {
    const graphData = projectGraphData(persistedEvents);
    if (selectedProfile.name !== graphData.workflowProfile) {
      throw new Error(
        `Cannot resume ${manifest.runId} with Workflow Profile ${selectedProfile.name};`
        + ` the run was created with ${graphData.workflowProfile}.`,
      );
    }
    if (selectedProfile.profile.domain !== graphData.domain) {
      throw new Error(
        `Cannot resume ${manifest.runId} with domain ${selectedProfile.profile.domain};`
        + ` the persisted GraphData requires ${graphData.domain}.`,
      );
    }
    recovery = {
      graphData,
      workflowData: projectWorkflowData(selectedWorkflowId!, persistedEvents),
      journalRoot: journalRoot!,
    };
  } else {
    if (selectedWorkflowId) await interactionPort.disclose({
      level: "warn",
      source: "workflow.resume",
      message: `Workflow journal for ${selectedWorkflowId} is missing; Run ${manifest.runId} will wait without an active Workflow.`,
      data: {
        runId: manifest.runId,
        missingWorkflowId: selectedWorkflowId,
        missingJournalPath: journalPath,
      },
    });
  }
  const logger = new Logger({
    runId: manifest.runId,
    logsRoot: runPaths(runRoot).logsRoot,
  });
  const resumeStartedAt = Date.now();
  logger.info({
    module: "run.lifecycle",
    event: "run_resume_started",
    message: `Resuming Scout run ${manifest.runId} from ${runRoot}.`,
    data: {
      runRoot,
      scoutRoot,
      checkpointSeq: manifest.checkpointSeq,
    },
  });
  const executor = new RunStageExecutor({
    runId: manifest.runId,
    logger,
    onStateChange: (snapshot) => interactionPort.publishRunLifecycleSnapshot(snapshot),
  });
  const runScope = new RunScope({
    runId: manifest.runId,
    scoutRoot,
    runRoot,
    logger,
    eventBus,
    interactionPort,
    config,
    scoutConfig,
    manifestStore,
    terminate: (reason) => executor.terminate(reason),
  });
  const assembly = new ResumeRunStageAssembly({
    executor,
    runScope,
    workflow,
    recovery,
    missingWorkflowId: persistedEvents ? undefined : selectedWorkflowId,
    clientsStage: new ResumeClientsStage({ allowMissingHome: initializeEnvironment }),
    environmentStage: initializeEnvironment
      ? new PrepareEnvironmentStage()
      : new RestoreEnvironmentStage(),
  });

  try {
    await assembly.executor.startup();
  } catch (error) {
    try {
      logger.error({
        module: "run.lifecycle",
        event: "run_resume_failed",
        message: `Scout run ${manifest.runId} failed while restoring its runtime.`,
        data: {
          error: error instanceof Error ? error.stack ?? error.message : String(error),
          lifecycle: assembly.executor.snapshot(),
        },
      });
    } catch {
      // Preserve the startup error if its diagnostic cannot be persisted.
    }
    throw error;
  }

  try {
    const scope = currentRunScope();
    const readyAt = new Date().toISOString();
    scope.manifestStore.update((current) => ({
      ...current,
      scoutRoot: scope.scoutRoot,
      runtime: {
        status: "ready",
        mode: "resume",
        processId: process.pid,
      },
      checkpointSeq: scope.workflow.lastSeq,
    }));
    await scope.eventBus.publishAndWait(RunEvents.runtime.ready, {
      mode: "resume",
      readyAt,
    }, {
      occurredAt: readyAt,
    });
    scope.agentOrchestrator.ready();
    const checkpointSeq = scope.workflow.lastSeq;
    const agentIds = scope.agentRegistry.listAgents().map((agent) => agent.agentId);
    scope.logger.info({
      module: "run.lifecycle",
      event: "run_ready",
      message: `Scout run ${manifest.runId} resumed and is ready with ${agentIds.length} agents.`,
      data: {
        mode: "resume",
        durationMs: Math.max(0, Date.now() - resumeStartedAt),
        agents: agentIds,
        checkpointSeq,
      },
    });
    scope.eventBus.publish(SystemEvents.interaction.disclosureRequested, {
      level: "info",
      source: "run.resume",
      message: "Scout run resumed.",
      data: {
        runId: manifest.runId,
        checkpointSeq,
      },
    } satisfies RuntimeDisclosureEvent);
    return toRunSummary(scope.environment, scope.workflow.graph.snapshot());
  } catch (error) {
    await assembly.executor.terminate("startup_failed");
    try {
      logger.error({
        module: "run.lifecycle",
        event: "run_resume_activation_failed",
        message: `Scout run ${manifest.runId} restored its runtime but failed during activation.`,
        data: { error: error instanceof Error ? error.stack ?? error.message : String(error) },
      });
    } catch {
      // Diagnostics must not replace the failure that required termination.
    }
    throw error;
  }
}

/** Resolves either a run id beneath `<cwd>/run` or an explicitly supplied run path. */
function resolveRunRoot(cwd: string, run: string): string {
  const direct = isAbsolute(run) ? resolve(run) : resolve(cwd, run);
  const candidates = isAbsolute(run) || run.includes("/") || run.includes("\\")
    ? [direct]
    : [scoutRunRoot(resolve(cwd), run), direct];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!isDirectory(candidate) || !isRunManifest(candidate)) continue;
    return candidate;
  }
  throw new Error(`Scout run directory does not exist: ${run}`);
}

/** Performs the non-throwing directory probe used during run discovery. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Checks whether a candidate directory has the persisted run manifest marker. */
function isRunManifest(path: string): boolean {
  try {
    return statSync(runPaths(path).manifestPath).isFile();
  } catch {
    return false;
  }
}

/** Projects the restored in-memory environment into the public run summary. */
function toRunSummary(environment: RunEnvironment, graphData: GraphData): ScoutRunSummary {
  const coordinator = environment.agents[resolveSynthesisRole(graphData).name];
  return {
    status: "passed",
    runId: environment.contextBundle.runId,
    coordinatorMountRoot: coordinator.mount.mountRoot,
    rootAccess: environment.rootAccess,
    agents: mapAgents(environment, (agent) => ({
      mountId: agent.mount.mountId,
      mountRoot: agent.mount.mountRoot,
      agentRoot: agent.mount.agentRoot,
      assetCommitId: agent.assetCommit.assetCommitId,
      assetCommitPath: agent.assetCommitPath,
      preflightStatus: agent.preflight.status,
      preflightPath: agent.preflightPath,
    })),
  };
}

/** Applies a summary projection to every role without changing environment state. */
function mapAgents<T>(
  environment: RunEnvironment,
  mapper: (agent: RunAgentEnvironment) => T,
): Record<ScoutAgentRole, T> {
  return Object.fromEntries(
    Object.entries(environment.agents).map(([role, agent]) => [role, mapper(agent)]),
  ) as Record<ScoutAgentRole, T>;
}
