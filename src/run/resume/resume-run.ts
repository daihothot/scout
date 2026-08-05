import { statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ScoutAgentRoles, type ScoutAgentRole } from "../../agent/thread/types.js";
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
import { projectRun } from "./projection/index.js";
import { ResumeRunStageAssembly } from "./resume-run-stage-assembly.js";

export async function resumeRun(
  options: ResumeRunOptions,
): Promise<ScoutRunSummary> {
  const runRoot = resolveRunRoot(options.cwd, options.run);
  const manifestStore = new RunManifestStore(runRoot);
  const manifest = manifestStore.read();
  const runDirectory = dirname(runRoot);
  if (basename(runRoot) !== manifest.runId || basename(runDirectory) !== "run") {
    throw new Error(
      `Run directory ${runRoot} must be <ScoutRoot>/run/${manifest.runId}.`,
    );
  }
  const repoRoot = dirname(runDirectory);
  const interactionPort = options.interactionPort ?? new NoopRuntimeInteractionPort();
  const logger = new Logger({
    runId: manifest.runId,
    logsRoot: join(runRoot, "logs"),
  });
  const journal = RunJournal.open({ runId: manifest.runId, runRoot });
  const eventBus = new InMemoryEventBus();
  const executor = new RunStageExecutor({
    runId: manifest.runId,
    logger,
    onStateChange: (snapshot) => interactionPort.publishRunLifecycleSnapshot(snapshot),
  });
  const runScope = new RunScope({
    runId: manifest.runId,
    repoRoot,
    logger,
    eventBus,
    interactionPort,
    domain: new ValidationDomain(),
    journal,
    manifestStore,
    terminate: (reason) => executor.terminate(reason),
  });
  const assembly = new ResumeRunStageAssembly({
    executor,
    runScope,
  });

  try {
    await assembly.executor.startup();
  } catch (error) {
    logger.error({
      module: "run.lifecycle",
      event: "run_resume_failed",
      data: {
        error: error instanceof Error ? error.stack ?? error.message : String(error),
        lifecycle: assembly.executor.snapshot(),
      },
    });
    throw error;
  }

  try {
    const scope = currentRunScope();
    const readyAt = new Date().toISOString();
    scope.eventBus.publish(RunEvents.runtime.ready, {
      mode: "resume",
      readyAt,
    }, {
      occurredAt: readyAt,
    });
    scope.manifestStore.update((current) => ({
      ...current,
      repoRoot: scope.repoRoot,
      runtime: {
        status: "ready",
        mode: "resume",
        processId: process.pid,
      },
      checkpointSeq: scope.journal.lastSeq,
    }));
    assembly.injectResumeContextStage.activate();
  } catch (error) {
    await assembly.executor.terminate("startup_failed");
    logger.error({
      module: "run.lifecycle",
      event: "run_resume_activation_failed",
      data: { error: error instanceof Error ? error.stack ?? error.message : String(error) },
    });
    throw error;
  }
  const scope = currentRunScope();
  scope.eventBus.publish(SystemEvents.interaction.disclosureRequested, {
    level: "info",
    source: "run.resume",
    message: "Scout run resumed.",
    data: {
      runId: manifest.runId,
      checkpointSeq: projectRun(scope.journal.readAll()).checkpointSeq,
    },
  } satisfies RuntimeDisclosureEvent);
  return toRunSummary(scope.environment);
}

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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRunManifest(path: string): boolean {
  try {
    return statSync(join(path, "run.json")).isFile();
  } catch {
    return false;
  }
}

function toRunSummary(environment: RunEnvironment): ScoutRunSummary {
  const coordinator = environment.agents[ScoutAgentRoles.Coordinator];
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

function mapAgents<T>(
  environment: RunEnvironment,
  mapper: (agent: RunAgentEnvironment) => T,
): Record<ScoutAgentRole, T> {
  return Object.fromEntries(
    Object.entries(environment.agents).map(([role, agent]) => [role, mapper(agent)]),
  ) as Record<ScoutAgentRole, T>;
}
