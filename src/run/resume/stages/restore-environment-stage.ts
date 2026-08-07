import { preflightCodexAppServerMount } from "../../../agent-server/codex/app-server-preflight.js";
import type { AgentServerPreflightReport } from "../../../agent-server/types.js";
import { join, resolve } from "node:path";
import { AssetStore, type CodexMount, type MaterializeOptions } from "../../../asset-store/index.js";
import { ScoutAgentRoles, type ScoutAgentRole } from "../../../agent/thread/types.js";
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
import type { MountRestoreStep } from "../../progress/mount/index.js";
import {
  applyMountMaterializationStep,
  applyMountPreflightStep,
  applyMountPreparationDecision,
  beginMountPreflightStep,
  completeMountRole,
  createMountRestoreProgress,
  createMountRestoreProgressPublisher,
  failMountRole,
  finishMountRestore,
  planMountRestore,
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
    const repoRoot = resolve(scope.repoRoot);
    const runRoot = resolve(repoRoot, "run", scope.runId);
    const roles = Object.values(ScoutAgentRoles);
    const assetStore = this.options.assetStore ?? new AssetStore();
    const preflightMount = this.options.preflightMount ?? ((mount: CodexMount) =>
      preflightCodexAppServerMount({ mount, appServer: scope.appServer })
    );
    const progress = createMountRestoreProgress(roles);
    const publishProgress = createMountRestoreProgressPublisher(scope.interactionPort);
    await publishProgress(progress);

    let snapshot: EnvironmentSnapshot;
    try {
      snapshot = new EnvironmentSnapshotLoader({
        repoRoot,
        runId: scope.runId,
        manifest: scope.manifestStore.read(),
        roles,
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
    const inputs: EnvironmentRolePreparationInput[] = snapshot.agents.map((persisted) => {
      const agentRoot = join(runRoot, "agents", persisted.role);
      const options: MaterializeOptions = {
        repoRoot,
        runId: scope.runId,
        agentId: persisted.role,
        persistedManifest: persisted.mountManifest,
        cleanRunRoot: false,
        persistedIdentity: {
          assetCommitId: persisted.assetCommit.assetCommitId,
          parentAssetCommitId: persisted.assetCommit.parentAssetCommitId,
          mountId: persisted.assetCommit.mountId,
          resourceHash: persisted.assetCommit.resourceHash,
          allowLegacyResourceIdentityMigration:
            persisted.allowLegacyResourceIdentityMigration,
        },
        onPreparationDecision: (decision, reason) => {
          const planned = plansByRole.get(persisted.role)?.inspection.decision;
          if (planned && planned !== decision) {
            throw new Error(
              `Mount preparation changed after verification for ${persisted.role}`
              + `: planned=${planned} actual=${decision}`,
            );
          }
          applyMountPreparationDecision(progress, persisted.role, decision, reason, true);
          void publishProgress(progress).catch(() => undefined);
        },
        onMaterializationStep: (step) => {
          applyMountMaterializationStep(progress, persisted.role, step);
          void publishProgress(progress).catch(() => undefined);
        },
      };
      return {
        role: persisted.role,
        options,
        expectedMountManifestPath: persisted.mountManifestPath,
        assetCommitPath: persisted.assetCommitPath,
        preflightPath: persisted.preflightPath,
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
    planMountRestore(
      progress,
      new Map(plans.map((plan) => [plan.role, plan.inspection] as const)),
    );
    await publishProgress(progress);

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

    const rollback = new EnvironmentMetadataRollback(snapshot);
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
      });
      const changedRoles = roles.filter((role) => {
        const persisted = persistedByRole.get(role);
        const current = result[role];
        return Boolean(
          persisted
          && current
          && persisted.assetCommit.resourceHash !== current.assetCommit.resourceHash,
        );
      });
      const transaction = new EnvironmentMetadataTransaction({
        rollback,
        commitIndex: changedRoles.length > 0
          ? (nextAgents) => updateResourceHashes(scope, nextAgents, roles)
          : undefined,
      });
      metadataTransactionStarted = true;
      transaction.commit(result);
      scope.setEnvironment(environment);
      finishMountRestore(progress);
      await publishProgress(progress);
    } catch (error) {
      if (!metadataTransactionStarted) restoreWithoutMasking(error, rollback);
      throw error;
    }
  }
}

/** Commits portable resource identities back to the persisted run index. */
function updateResourceHashes(
  scope: ReturnType<typeof currentRunScope>,
  agents: EnvironmentRoleRunnerResult,
  roles: readonly ScoutAgentRole[],
): void {
  scope.manifestStore.update((current) => {
    if (!current.agents) {
      throw new Error(`Run ${current.runId} has no persisted agent index.`);
    }
    const nextAgents = { ...current.agents };
    for (const role of roles) {
      const agent = agents[role];
      const entry = nextAgents[role];
      if (!agent || !entry) {
        throw new Error(`Run manifest has no environment entry for ${role}.`);
      }
      nextAgents[role] = {
        ...entry,
        resourceHash: agent.assetCommit.resourceHash,
      };
    }
    return { ...current, agents: nextAgents };
  });
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
  progress: ReturnType<typeof createMountRestoreProgress>,
  publishProgress: (progress: ReturnType<typeof createMountRestoreProgress>) => Promise<void>,
  role: ScoutAgentRole | undefined,
  step: EnvironmentRoleStep,
  error: unknown,
): Promise<void> {
  if (!role) return;
  const reason = error instanceof Error ? error.message : String(error);
  const wasFailed = progress.phase === "failed";
  failMountRole(progress, role, step as MountRestoreStep, reason);
  await publishProgress(progress);
  if (!wasFailed) {
    await discloseMountRestoreFailure(scope, role, step as MountRestoreStep, reason);
  }
}

async function discloseMountRestoreFailure(
  scope: ReturnType<typeof currentRunScope>,
  role: ScoutAgentRole,
  step: MountRestoreStep,
  reason: string,
): Promise<void> {
  const detail = reason.split("\n", 1)[0]?.slice(0, 180);
  try {
    await scope.interactionPort.disclose({
      level: "error",
      source: "run.mount-restore",
      message: `Mount restore failed · ${role} ${step}${detail ? `: ${detail}` : ""}`,
    });
  } catch {
    // Disclosure is observational; preserve the original stage failure.
  }
}
