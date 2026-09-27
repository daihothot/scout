import { statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ScoutAgentRole } from "../../agent/thread/types.js";
import { InMemoryEventBus } from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import {
  resolveSynthesisRole,
  projectWorkflowFlowState,
  Workflow,
  WorkflowBenchmarks,
  WorkflowEvents,
  type GraphState,
} from "../../core/workflow/index.js";
import { readJournalEvents, type JournalEvent } from "../../core/journal/index.js";
import { AssetStore, readWorkflowProfile } from "../../asset-store/index.js";
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
import {
  projectGraphState,
  projectRun,
  readDomainJournalProjections,
} from "./projection/index.js";
import { ResumeRunStageAssembly } from "./resume-run-stage-assembly.js";
import { PrepareEnvironmentStage } from "../startup/stages/prepare-environment-stage.js";
import { RestoreEnvironmentStage, ResumeClientsStage } from "./stages/index.js";

/**
 * Reopens a persisted run and executes its resume lifecycle.
 *
 * The selected journal must belong to this run. A missing benchmark target
 * starts a new Flow within the same run; other journal failures are fatal.
 * Stage-owned restoration rebuilds runtime resources, then activation
 * re-enables any work represented by the selected Flow's journal projection.
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
  const selectedFlow = new WorkflowBenchmarks(runRoot).resolve("currentFlow");
  if (!selectedFlow) {
    throw new Error("Workflow benchmarks do not contain a current Flow.");
  }
  const journalRoot = selectedFlow.journalRoot;
  const journalPath = join(journalRoot, "scout.journal");
  let persistedEvents: JournalEvent[] | undefined;
  try {
    persistedEvents = readJournalEvents(journalPath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  if (persistedEvents) {
    const runCreated = persistedEvents.find((event) => RunEvents.run.created.is(event));
    if (!runCreated || !RunEvents.run.created.is(runCreated)) {
      throw new Error(`Cannot resume ${manifest.runId}: Workflow Flow ${selectedFlow.flowId} is missing run.created.`);
    }
    if (runCreated.payload.runId !== manifest.runId) {
      throw new Error(
        `Cannot resume ${manifest.runId}: Workflow Flow ${selectedFlow.flowId}`
        + ` belongs to Run ${runCreated.payload.runId}.`,
      );
    }
  }
  // An absent index is only an unfinished bootstrap when the selected journal
  // proves that no Agent or phase execution has begun. Never rebuild an
  // established runtime from missing metadata or missing evidence.
  const initializeEnvironment = manifest.agents === undefined;
  if (initializeEnvironment) {
    if (!persistedEvents) {
      throw new Error(
        `Cannot initialize Run ${manifest.runId}: its environment index is missing`
        + " and the missing Workflow journal cannot establish incomplete initialization.",
      );
    }
    if (persistedEvents.some((event) => event.key.scope === "agent"
      || WorkflowEvents.workflow.advanced.is(event)
      || WorkflowEvents.workflow.completed.is(event))) {
      throw new Error(
        `Cannot initialize Run ${manifest.runId}: its environment index is missing`
        + " but the Workflow journal already contains execution facts.",
      );
    }
  }
  const assetStore = new AssetStore();
  const config = assetStore.config(scoutRoot);
  const scoutConfig = loadScoutConfig(config);
  const eventBus = new InMemoryEventBus();
  let workflow: Workflow;
  if (persistedEvents) {
    const graphState = projectGraphState(persistedEvents);
    const selectedProfile = readWorkflowProfile(scoutRoot, scoutConfig.workflow.profile);
    if (selectedProfile.name !== graphState.workflowProfile) {
      throw new Error(
        `Cannot resume ${manifest.runId} with Workflow Profile ${selectedProfile.name};`
        + ` the run was created with ${graphState.workflowProfile}.`,
      );
    }
    if (selectedProfile.profile.domain !== graphState.domain) {
      throw new Error(
        `Cannot resume ${manifest.runId} with domain ${selectedProfile.profile.domain};`
        + ` the persisted GraphState requires ${graphState.domain}.`,
      );
    }
    workflow = new Workflow({
      graphState,
      resume: {
        flow: projectWorkflowFlowState(selectedFlow.flowId, persistedEvents),
        journalRoot,
      },
    });
  } else {
    workflow = new Workflow({
      graphState: assetStore.buildWorkflow(scoutRoot, scoutConfig.workflow.profile),
      expectedMissingFlow: selectedFlow,
      startBaseline: [{
        id: `run-created-${manifest.runId}`,
        key: RunEvents.run.created,
        payload: {
          runId: manifest.runId,
          scoutRoot,
          createdAt: manifest.createdAt,
        },
        occurredAt: manifest.createdAt,
      }],
    });
    await interactionPort.disclose({
      level: "warn",
      source: "workflow.resume",
      message: `Workflow journal ${journalPath} is missing; starting a new Flow in Run ${manifest.runId}.`,
      data: {
        runId: manifest.runId,
        missingFlowId: selectedFlow.flowId,
        missingJournalPath: journalPath,
      },
    });
  }
  const logger = new Logger({
    runId: manifest.runId,
    logsRoot: join(runRoot, "logs"),
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
    assembly.injectResumeContextStage.activate();
    const checkpointSeq = projectRun(
      scope.workflow.readEvents(),
      resolveSynthesisRole(scope.workflow.scheduler.snapshot()).name,
      readDomainJournalProjections(scope.domainRegistry.list()),
    ).checkpointSeq;
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
    return toRunSummary(scope.environment, scope.workflow.scheduler.snapshot());
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
    : [resolve(cwd, "run", run), direct];
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
    return statSync(join(path, "run.json")).isFile();
  } catch {
    return false;
  }
}

/** Projects the restored in-memory environment into the public run summary. */
function toRunSummary(environment: RunEnvironment, graphState: GraphState): ScoutRunSummary {
  const coordinator = environment.agents[resolveSynthesisRole(graphState).name];
  return {
    status: "passed",
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

/** Applies a summary projection to every role without changing environment state. */
function mapAgents<T>(
  environment: RunEnvironment,
  mapper: (agent: RunAgentEnvironment) => T,
): Record<ScoutAgentRole, T> {
  return Object.fromEntries(
    Object.entries(environment.agents).map(([role, agent]) => [role, mapper(agent)]),
  ) as Record<ScoutAgentRole, T>;
}
