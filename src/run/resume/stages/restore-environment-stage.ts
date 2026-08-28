import { createCodexAppServerMountPreflight } from "../../../agent-server/codex/app-server-preflight.js";
import type { AgentServerPreflightReport } from "../../../agent-server/types.js";
import { join, resolve } from "node:path";
import { AssetStore, type CodexMount, type MaterializeOptions } from "../../../asset-store/index.js";
import type { ScoutAgentRole } from "../../../agent/thread/types.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../../lifecycle/index.js";
import {
  EnvironmentMetadataRollback,
  EnvironmentMetadataTransaction,
  EnvironmentRolePlanner,
  EnvironmentRolePlanningError,
  EnvironmentRoleRunner,
  EnvironmentSnapshotLoader,
  EnvironmentSnapshotLoadError,
  RunEnvironmentBuilder,
  describeEnvironmentPreflightFailures,
  requireEnvironmentAgents,
  type EnvironmentRolePlan,
  type EnvironmentRolePreparationInput,
  type EnvironmentRoleRunnerResult,
  type EnvironmentRoleStep,
  type EnvironmentSnapshot,
} from "../../environment/index.js";
import type { MountPreparationStep } from "../../progress/mount/index.js";
import {
  applyMountMaterializationStep,
  applyMountPreflightStep,
  applyMountPreparationDecision,
  beginMountPreflightStep,
  completeMountRole,
  createMountPreparationProgress,
  createMountPreparationProgressPublisher,
  failMountRole,
  finishMountPreparation,
  planMountPreparation,
} from "../../progress/mount/index.js";

/** Injectable environment dependencies used by tests and alternate runtimes. */
export interface RestoreEnvironmentStageOptions {
  assetStore?: AssetStore;
  preflightMount?(mount: CodexMount): Promise<AgentServerPreflightReport>;
}

/**
 * Orchestrates restoration of the persisted role environment.
 *
 * Snapshot loading, inspection, mount preparation, preflight, environment
 * assembly, and metadata transaction mechanics live in `run/environment`.
 * This stage owns only resume ordering, progress publication, run-scope
 * integration, and failure disclosure/rollback coordination.
 */
export class RestoreEnvironmentStage implements RunStage {
  readonly id = "restore_environment";
  private readonly options: RestoreEnvironmentStageOptions;

  constructor(options: RestoreEnvironmentStageOptions = {}) {
    this.options = options;
  }

  /** Restores all role mounts, commits artifacts/index updates, and publishes completion. */
  async start(): Promise<void> {
    const scope = currentRunScope();
    const scoutRoot = resolve(scope.scoutRoot);
    const runRoot = resolve(scope.runRoot);
    const roles = scope.scheduler.snapshot().roles.map((role) => role.name);
    const assetStore = this.options.assetStore ?? new AssetStore();
    const progress = createMountPreparationProgress(roles);
    const publishProgress = createMountPreparationProgressPublisher(scope.interactionPort);
    await publishProgress(progress);

    let snapshot: EnvironmentSnapshot;
    try {
      const manifest = scope.manifestStore.read();
      const persistedRoles = roles.filter((role) => manifest.agents?.[role] !== undefined);
      snapshot = new EnvironmentSnapshotLoader({
        scoutRoot,
        runRoot,
        manifest,
        roles: persistedRoles,
      }).load();
    } catch (error) {
      const role = error instanceof EnvironmentSnapshotLoadError
        ? error.role
        : roles[0];
      await reportMountFailure(scope, progress, publishProgress, role, "verify", error);
      throw error;
    }

    const persistedByRole = new Map(snapshot.agents.map((agent) => [agent.role, agent] as const));
    const plansByRole = new Map<ScoutAgentRole, EnvironmentRolePlan>();
    const inputs: EnvironmentRolePreparationInput[] = roles.map((role) => {
      const persisted = persistedByRole.get(role);
      const agentRoot = join(runRoot, "agents", role);
      const artifactRoot = join(agentRoot, "artifacts");
      const options: MaterializeOptions = {
        scoutRoot,
        runId: scope.runId,
        agentId: role,
        workflowProfileName: scope.scoutConfig.workflow.profile,
        ...(persisted === undefined ? {} : {
          persistedManifest: persisted.mountManifest,
          persistedIdentity: {
            assetCommitId: persisted.assetCommit.assetCommitId,
            parentAssetCommitId: persisted.assetCommit.parentAssetCommitId,
            mountId: persisted.assetCommit.mountId,
            resourceHash: persisted.assetCommit.resourceHash,
          },
        }),
        cleanRunRoot: false,
        allowAssetResourceDrift: scope.scoutConfig.restore.allowAssetResourceDrift,
        onPreparationDecision: (decision, reason) => {
          const planned = plansByRole.get(role)?.inspection.decision;
          if (planned && planned !== decision) {
            throw new Error(
              `Mount preparation changed after verification for ${role}`
              + `: planned=${planned} actual=${decision}`,
            );
          }
          applyMountPreparationDecision(progress, role, decision, reason, true);
          void publishProgress(progress).catch(() => undefined);
        },
        onMaterializationStep: (step) => {
          applyMountMaterializationStep(progress, role, step);
          void publishProgress(progress).catch(() => undefined);
        },
      };
      return {
        role,
        options,
        expectedMountManifestPath: persisted?.mountManifestPath
          ?? join(agentRoot, "mount", "mount-manifest.json"),
        assetCommitPath: persisted?.assetCommitPath
          ?? join(artifactRoot, "asset-commit.json"),
        preflightPath: persisted?.preflightPath
          ?? join(artifactRoot, "app-server-preflight.json"),
      };
    });

    let plans: EnvironmentRolePlan[];
    try {
      plans = new EnvironmentRolePlanner(assetStore).plan(inputs);
    } catch (error) {
      const role = error instanceof EnvironmentRolePlanningError
        ? error.role
        : roles[0];
      await reportMountFailure(scope, progress, publishProgress, role, "verify", error);
      throw error;
    }
    for (const plan of plans) plansByRole.set(plan.role, plan);
    planMountPreparation(
      progress,
      new Map(plans.map((plan) => [plan.role, plan.inspection] as const)),
    );
    await publishProgress(progress);
    const preflightMount = this.options.preflightMount
      ?? createCodexAppServerMountPreflight(
        scope.appServer,
        plans.some((plan) => plan.inspection.decision === "rebuild") ? 4 : 1,
      );

    const runner = new EnvironmentRoleRunner(assetStore, preflightMount, {
      onRoleStart: async (role) => {
        if (progress.phase === "failed") return;
        progress.activeRole = role;
        progress.activeStep = "verify";
        await publishProgress(progress);
      },
      onPreflightStart: async (role) => {
        beginMountPreflightStep(progress, role);
        await publishProgress(progress);
      },
      onRoleComplete: async (role, plan) => {
        if (plan.inspection.decision === "rebuild") {
          applyMountPreflightStep(progress, role);
        }
        completeMountRole(progress, role);
        await publishProgress(progress);
      },
      onRoleFailure: async (role, step, error) => {
        await reportMountFailure(scope, progress, publishProgress, role, step, error);
      },
    });

    const rollback = new EnvironmentMetadataRollback(snapshot, scope.manifestStore);
    let result: EnvironmentRoleRunnerResult;
    let metadataTransactionStarted = false;
    try {
      result = await runner.runAll(plans);
      const agents = requireEnvironmentAgents(result, roles);
      const failures = describeEnvironmentPreflightFailures(result);
      if (failures.length > 0) {
        throw new Error(`Scout run restore preflight failed: ${failures.join("; ")}.`);
      }

      const environment = new RunEnvironmentBuilder(assetStore).build({
        runId: scope.runId,
        agents,
        graphState: scope.scheduler.snapshot(),
      });
      const transaction = new EnvironmentMetadataTransaction({
        rollback,
        manifestStore: scope.manifestStore,
        runRoot,
      });
      metadataTransactionStarted = true;
      transaction.commit(result);
      scope.setEnvironment(environment);
      finishMountPreparation(progress);
      await publishProgress(progress);
    } catch (error) {
      if (!metadataTransactionStarted) restoreWithoutMasking(error, rollback);
      throw error;
    }
  }
}

/** Attempts metadata rollback while retaining the original operation failure. */
function restoreWithoutMasking(error: unknown, rollback: EnvironmentMetadataRollback): void {
  try {
    rollback.restore();
  } catch (rollbackError) {
    if (error instanceof Error) {
      Object.defineProperty(error, "rollbackError", {
        configurable: true,
        enumerable: false,
        value: rollbackError,
      });
    }
  }
}

/** Publishes one mount failure and discloses it once at the interaction boundary. */
async function reportMountFailure(
  scope: ReturnType<typeof currentRunScope>,
  progress: ReturnType<typeof createMountPreparationProgress>,
  publishProgress: (progress: ReturnType<typeof createMountPreparationProgress>) => Promise<void>,
  role: ScoutAgentRole | undefined,
  step: EnvironmentRoleStep,
  error: unknown,
): Promise<void> {
  if (!role) return;
  const reason = error instanceof Error ? error.message : String(error);
  const wasFailed = progress.phase === "failed";
  failMountRole(progress, role, step as MountPreparationStep, reason);
  await publishProgress(progress);
  if (!wasFailed) {
    await discloseMountPreparationFailure(scope, role, step as MountPreparationStep, reason);
  }
}

async function discloseMountPreparationFailure(
  scope: ReturnType<typeof currentRunScope>,
  role: ScoutAgentRole,
  step: MountPreparationStep,
  reason: string,
): Promise<void> {
  const detail = reason.split("\n", 1)[0]?.slice(0, 180);
  try {
    await scope.interactionPort.disclose({
      level: "error",
      source: "run.mount-preparation",
      message: `Mount preparation failed · ${role} ${step}${detail ? `: ${detail}` : ""}`,
    });
  } catch {
    // Disclosure is observational; preserve the original stage failure.
  }
}
