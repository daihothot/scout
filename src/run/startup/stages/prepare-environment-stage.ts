import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  createCodexAppServerMountPreflight,
} from "../../../agent-server/codex/app-server-preflight.js";
import type { AgentServerPreflightReport } from "../../../agent-server/types.js";
import {
  AssetStore,
  type CodexMount,
  type MaterializeOptions,
} from "../../../asset-store/index.js";
import type { ScoutAgentRole } from "../../../agent/thread/types.js";
import { isPathWithin } from "../../../core/path.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunAgentManifestEntry } from "../../persistence/index.js";
import type { RunAgentEnvironment, RunRootAccess } from "../../types.js";
import type { RunStage } from "../../lifecycle/run-stage.js";
import {
  EnvironmentArtifactWriter,
  EnvironmentRolePlanner,
  EnvironmentRolePlanningError,
  EnvironmentRoleRunner,
  RunEnvironmentBuilder,
  describeEnvironmentPreflightFailures,
  requireEnvironmentAgents,
  type EnvironmentRolePlan,
  type EnvironmentRolePreparationInput,
  type EnvironmentRoleStep,
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

/** Dependency overrides used to exercise startup environment orchestration. */
export interface PrepareEnvironmentStageOptions {
  agentRoles?: readonly ScoutAgentRole[];
  assetStore?: AssetStore;
  preflightMount?(mount: CodexMount): Promise<AgentServerPreflightReport>;
}

/**
 * Startup owns only orchestration and run persistence. The reusable mount,
 * preflight, and runtime construction policies live under run/environment.
 */
export class PrepareEnvironmentStage implements RunStage {
  readonly id = "environment";
  private readonly options: PrepareEnvironmentStageOptions;
  private preparedAgents?: Record<ScoutAgentRole, RunAgentEnvironment>;
  private preparedRootAccess?: RunRootAccess;

  constructor(options: PrepareEnvironmentStageOptions = {}) {
    this.options = options;
  }

  get scoutRoot(): string {
    return currentRunScope().scoutRoot;
  }

  get runId(): string {
    return currentRunScope().runId;
  }

  get runRoot(): string {
    return currentRunScope().runRoot;
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
    const scoutRoot = resolve(scope.scoutRoot);
    const runRoot = resolve(scope.runRoot);
    const roles = this.options.agentRoles
      ?? scope.scheduler.snapshot().roles.map((role) => role.name);
    assertMaterializationPath(scoutRoot, runRoot);
    assertMaterializationPath(scoutRoot, join(runRoot, "agents"));

    const assetStore = this.options.assetStore ?? new AssetStore();
    const progress = createMountPreparationProgress(roles);
    const publishProgress = createMountPreparationProgressPublisher(scope.interactionPort);
    await publishProgress(progress);

    const plansByRole = new Map<ScoutAgentRole, EnvironmentRolePlan>();
    const inputs: EnvironmentRolePreparationInput[] = [];
    for (const role of roles) {
      const agentRoot = join(runRoot, "agents", role);
      assertMaterializationPath(scoutRoot, agentRoot);
      const artifactRoot = join(agentRoot, "artifacts");
      const preparationOptions: MaterializeOptions = {
        scoutRoot,
        runId: scope.runId,
        agentId: role,
        workflowProfileName: scope.scoutConfig.workflow.profile,
        cleanRunRoot: false,
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
      inputs.push({
        role,
        options: preparationOptions,
        expectedMountManifestPath: join(agentRoot, "mount", "mount-manifest.json"),
        assetCommitPath: join(artifactRoot, "asset-commit.json"),
        preflightPath: join(artifactRoot, "app-server-preflight.json"),
      });
    }

    let plans: EnvironmentRolePlan[];
    try {
      plans = new EnvironmentRolePlanner(assetStore).plan(inputs);
    } catch (error) {
      const role = error instanceof EnvironmentRolePlanningError
        ? error.role
        : roles[0];
      await reportMountFailure(
        scope,
        progress,
        publishProgress,
        role,
        "verify",
        error,
      );
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

    const result = await runner.runAll(plans);
    const agents = requireEnvironmentAgents(result, roles);
    this.preparedAgents = agents;

    const environment = new RunEnvironmentBuilder(assetStore).build({
      runId: scope.runId,
      agents,
      graphState: scope.scheduler.snapshot(),
    });
    this.preparedRootAccess = environment.rootAccess;
    scope.setEnvironment(environment);

    new EnvironmentArtifactWriter().write(result);
    scope.manifestStore.update((manifest) => ({
      ...manifest,
      agents: buildManifestAgents(runRoot, environment.agents, roles),
      checkpointSeq: scope.journal.lastSeq,
    }));

    const failures = describeEnvironmentPreflightFailures(result);
    if (failures.length > 0) {
      throw new Error(`Scout run preflight failed: ${failures.join("; ")}.`);
    }

    finishMountPreparation(progress);
    await publishProgress(progress);
  }
}

function buildManifestAgents(
  runRoot: string,
  agents: Record<ScoutAgentRole, RunAgentEnvironment>,
  roles: readonly ScoutAgentRole[],
): Record<ScoutAgentRole, RunAgentManifestEntry> {
  const entries: Partial<Record<ScoutAgentRole, RunAgentManifestEntry>> = {};
  for (const role of roles) {
    const agent = agents[role];
    if (!agent) throw new Error(`Prepared environment did not produce agent runtime: ${role}`);
    entries[role] = {
      mountId: agent.mount.mountId,
      assetCommitId: agent.assetCommit.assetCommitId,
      resourceHash: agent.assetCommit.resourceHash,
      mountManifestRef: relative(runRoot, agent.mount.manifestPath),
      assetCommitRef: relative(runRoot, agent.assetCommitPath),
      preflightRef: relative(runRoot, agent.preflightPath),
    };
  }
  return entries as Record<ScoutAgentRole, RunAgentManifestEntry>;
}

async function reportMountFailure(
  scope: ReturnType<typeof currentRunScope>,
  progress: ReturnType<typeof createMountPreparationProgress>,
  publishProgress: (progress: ReturnType<typeof createMountPreparationProgress>) => Promise<void>,
  role: ScoutAgentRole | undefined,
  step: EnvironmentRoleStep,
  error: unknown,
): Promise<void> {
  if (!role) return;
  const reason = errorText(error);
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

function assertMaterializationPath(scoutRoot: string, runRoot: string): void {
  if (!isPathWithin(scoutRoot, runRoot, { allowRoot: false })) {
    throw new Error(`Run root escapes Scout root: ${runRoot}`);
  }
  const scoutRootReal = realpathSync(scoutRoot);
  let current = scoutRoot;
  const components = relative(scoutRoot, runRoot).split(sep);
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
    if (!isPathWithin(scoutRootReal, real)) {
      throw new Error(`Startup run component escapes Scout root: ${current}`);
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
