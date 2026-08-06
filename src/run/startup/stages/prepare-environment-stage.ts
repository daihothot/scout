import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  preflightCodexAppServerMount,
  summarizeAgentServerPreflight,
} from "../../../agent-server/codex/app-server-preflight.js";
import type { AgentServerPreflightReport } from "../../../agent-server/types.js";
import {
  AssetStore,
  type CodexMount,
  type MaterializeOptions,
} from "../../../asset-store/index.js";
import type {
  ScoutAgentRole,
} from "../../../agent/thread/types.js";
import { ScoutAgentRoles } from "../../../agent/thread/types.js";
import { writeJsonFile } from "../../../core/fs.js";
import { isPathWithin } from "../../../core/path.js";
import { currentRunScope } from "../../run-scope.js";
import {
  buildRunContextBundle,
  type RunAgentEnvironment,
} from "../../types.js";
import { buildRunRootAccess } from "../../root-access.js";
import type { RunRootAccess } from "../../types.js";
import type { RunAgentManifestEntry } from "../../persistence/index.js";
import type { RunStage } from "../../lifecycle/run-stage.js";
import type { MountRestoreProgress } from "../../../interaction/protocol/port.js";
import {
  applyMountMaterializationStep,
  applyMountPreflightStep,
  applyMountPreparationDecision,
  beginMountPreflightStep,
  completeMountRole,
  createMountRestoreProgress,
  discloseMountRestoreFailure,
  failMountRole,
  finishMountRestore,
  planMountRestore,
} from "../../mount-restore-progress.js";

export interface PrepareEnvironmentStageOptions {
  agentRoles?: readonly ScoutAgentRole[];
  assetStore?: AssetStore;
  preflightMount?(mount: CodexMount): Promise<AgentServerPreflightReport>;
}

export class PrepareEnvironmentStage implements RunStage {
  readonly id = "environment";
  private readonly options: PrepareEnvironmentStageOptions;
  private preparedAgents?: Record<ScoutAgentRole, RunAgentEnvironment>;
  private preparedRootAccess?: RunRootAccess;

  constructor(options: PrepareEnvironmentStageOptions = {}) {
    this.options = options;
  }

  get repoRoot(): string {
    return currentRunScope().repoRoot;
  }

  get runId(): string {
    return currentRunScope().runId;
  }

  get prepared(): boolean {
    return Boolean(this.preparedAgents && this.preparedRootAccess);
  }

  get agents(): Record<ScoutAgentRole, RunAgentEnvironment> {
    if (!this.preparedAgents) throw new Error("Prepare environment stage has not completed.");
    return this.preparedAgents;
  }

  get rootAccess(): RunRootAccess {
    if (!this.preparedRootAccess) throw new Error("Prepare environment stage has not completed.");
    return this.preparedRootAccess;
  }

  async start(): Promise<void> {
    const scope = currentRunScope();
    const repoRoot = resolve(scope.repoRoot);
    const runRoot = resolve(repoRoot, "run", scope.runId);
    assertMaterializationPath(repoRoot, runRoot);
    assertMaterializationPath(repoRoot, join(runRoot, "agents"));
    const assetStore = this.options.assetStore ?? new AssetStore();
    const preflightMount = this.options.preflightMount ?? ((mount) =>
      preflightCodexAppServerMount({
        mount,
        appServer: currentRunScope().appServer,
      })
    );
    const agentRoles = this.options.agentRoles ?? Object.values(ScoutAgentRoles);
    const agents: Partial<Record<ScoutAgentRole, RunAgentEnvironment>> = {};
    const progress = createMountRestoreProgress(agentRoles);
    await publishMountProgress(progress);

    const preparationOptions = new Map<ScoutAgentRole, MaterializeOptions>();
    const decisions = new Map<ScoutAgentRole, {
      decision: "reused" | "rebuild";
      reason?: string;
    }>();
    for (const role of agentRoles) {
      assertMaterializationPath(repoRoot, join(runRoot, "agents", role));
      progress.activeRole = role;
      progress.activeStep = "verify";
      await publishMountProgress(progress);
      const options: MaterializeOptions = {
        repoRoot,
        runId: scope.runId,
        agentId: role,
        cleanRunRoot: false,
        onPreparationDecision: (nextDecision, reason) => {
          const plannedDecision = decisions.get(role)?.decision;
          if (plannedDecision !== nextDecision) {
            throw new Error(
              "Mount preparation changed after verification for " + role
              + ": planned=" + plannedDecision + " actual=" + nextDecision,
            );
          }
          applyMountPreparationDecision(progress, role, nextDecision, reason, true);
          void publishMountProgress(progress).catch(() => undefined);
        },
        onMaterializationStep: (step) => {
          applyMountMaterializationStep(progress, role, step);
          void publishMountProgress(progress).catch(() => undefined);
        },
      };
      preparationOptions.set(role, options);
      try {
        decisions.set(role, assetStore.inspectMount(options));
      } catch (error) {
        failMountRole(progress, role, "verify", errorText(error));
        await publishMountProgress(progress);
        await discloseMountRestoreFailure(scope.interactionPort, role, "verify", errorText(error));
        throw error;
      }
    }
    planMountRestore(progress, decisions);
    await publishMountProgress(progress);

    for (const role of agentRoles) {
      if (progress.phase !== "failed") {
        progress.activeRole = role;
        progress.activeStep = "verify";
      }
      await publishMountProgress(progress);
      let mount: CodexMount;
      let decision: "reused" | "rebuild";
      try {
        const preparation = assetStore.prepareMount(preparationOptions.get(role)!);
        mount = preparation.mount;
        decision = preparation.decision;
      } catch (error) {
        const failureStep = progress.activeStep === "verify"
          ? "verify"
          : progress.activeStep ?? "wipe";
        failMountRole(
          progress,
          role,
          failureStep,
          errorText(error),
        );
        await publishMountProgress(progress);
        await discloseMountRestoreFailure(scope.interactionPort, role, failureStep, errorText(error));
        throw error;
      }

      if (decision === "rebuild") {
        beginMountPreflightStep(progress, role);
        await publishMountProgress(progress);
      }
      try {
        const preflight = await preflightMount(mount);
        const preflightPath = join(mount.artifactRoot, "app-server-preflight.json");
        writeJsonFile(preflightPath, summarizeAgentServerPreflight(preflight, mount));

        const preflightStatus = mount.issues.some((issue) => issue.severity === "error")
          ? "failed"
          : preflight.status;
        const assetCommit = assetStore.buildCommit({
          mount,
          preflightStatus,
          preflightPath,
        });
        const assetCommitPath = join(mount.artifactRoot, "asset-commit.json");
        writeJsonFile(assetCommitPath, assetCommit);

        agents[role] = {
          role,
          mount,
          preflight,
          preflightPath,
          assetCommit,
          assetCommitPath,
        };
        if (preflightStatus !== "passed" || assetCommit.status !== "preflight_passed") {
          failMountRole(progress, role, "preflight", preflight.error);
          await publishMountProgress(progress);
          await discloseMountRestoreFailure(
            scope.interactionPort,
            role,
            "preflight",
            preflight.error ?? "preflight failed",
          );
        } else if (decision === "rebuild") {
          applyMountPreflightStep(progress, role);
          completeMountRole(progress, role);
          await publishMountProgress(progress);
        }
      } catch (error) {
        if (progress.phase !== "failed") {
          failMountRole(progress, role, "preflight", errorText(error));
          await publishMountProgress(progress);
          await discloseMountRestoreFailure(scope.interactionPort, role, "preflight", errorText(error));
        }
        throw error;
      }
    }

    this.preparedAgents = requirePreparedAgents(agents, agentRoles);
    this.preparedRootAccess = buildRunRootAccess(assetStore, this.preparedAgents);
    const environment = {
      agents: this.preparedAgents,
      rootAccess: this.preparedRootAccess,
      contextBundle: buildRunContextBundle({
        runId: scope.runId,
        assetCommit: this.preparedAgents[ScoutAgentRoles.Coordinator].assetCommit,
      }),
    };
    scope.setEnvironment(environment);
    const toManifestEntry = (agent: RunAgentEnvironment): RunAgentManifestEntry => ({
      mountId: agent.mount.mountId,
      assetCommitId: agent.assetCommit.assetCommitId,
      resourceHash: agent.assetCommit.resourceHash,
      mountManifestRef: relative(runRoot, agent.mount.manifestPath),
      assetCommitRef: relative(runRoot, agent.assetCommitPath),
      preflightRef: relative(runRoot, agent.preflightPath),
    });
    scope.manifestStore.update((manifest) => ({
      ...manifest,
      agents: {
        [ScoutAgentRoles.Coordinator]: toManifestEntry(
          environment.agents[ScoutAgentRoles.Coordinator],
        ),
        [ScoutAgentRoles.Researcher]: toManifestEntry(
          environment.agents[ScoutAgentRoles.Researcher],
        ),
        [ScoutAgentRoles.Verifier]: toManifestEntry(
          environment.agents[ScoutAgentRoles.Verifier],
        ),
        [ScoutAgentRoles.Validator]: toManifestEntry(
          environment.agents[ScoutAgentRoles.Validator],
        ),
      },
      checkpointSeq: scope.journal.lastSeq,
    }));
    if (!Object.values(this.preparedAgents).every((agent) =>
      agent.assetCommit.status === "preflight_passed"
    )) {
      throw new Error("Scout run preflight failed.");
    }
    finishMountRestore(progress);
    await publishMountProgress(progress);
  }
}

function assertMaterializationPath(repoRoot: string, runRoot: string): void {
  if (!isPathWithin(repoRoot, runRoot, { allowRoot: false })) {
    throw new Error(`Run root escapes Scout root: ${runRoot}`);
  }
  const repoRootReal = realpathSync(repoRoot);
  let current = repoRoot;
  const components = relative(repoRoot, runRoot).split(sep);
  for (const component of components) {
    current = join(current, component);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symlinked startup run component: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Expected startup run component to be a directory: ${current}`);
    }
    const real = realpathSync(current);
    if (!isPathWithin(repoRootReal, real)) {
      throw new Error(`Startup run component escapes Scout root: ${current}`);
    }
  }
}

async function publishMountProgress(progress: MountRestoreProgress): Promise<void> {
  await currentRunScope().interactionPort.publishMountRestoreProgress({
    ...progress,
    roles: progress.roles.map((role) => ({ ...role })),
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requirePreparedAgents(
  agents: Partial<Record<ScoutAgentRole, RunAgentEnvironment>>,
  roles: readonly ScoutAgentRole[],
): Record<ScoutAgentRole, RunAgentEnvironment> {
  const result: Partial<Record<ScoutAgentRole, RunAgentEnvironment>> = {};
  for (const role of roles) {
    const agent = agents[role];
    if (!agent) throw new Error(`Prepared environment did not produce agent runtime: ${role}`);
    result[role] = agent;
  }
  return result as Record<ScoutAgentRole, RunAgentEnvironment>;
}
