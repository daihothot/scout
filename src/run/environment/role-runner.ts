import { resolve } from "node:path";
import type {
  AgentServerPreflightReport,
} from "../../agent-server/types.js";
import type {
  AssetStore,
  CodexMount,
  MountMaterializationStep,
} from "../../asset-store/index.js";
import type { ScoutAgentRole } from "../../agent/thread/types.js";
import type { RunAgentEnvironment } from "../types.js";
import { EnvironmentRoleBuilder } from "./role-builder.js";
import type {
  EnvironmentRolePlan,
  EnvironmentRoleRunnerHooks,
  EnvironmentRoleRunnerResult,
  EnvironmentRoleStep,
  EnvironmentMountPreflightBatch,
} from "./types.js";

/**
 * Prepares every role mount before running the shared preflight batch, then
 * assembles each role environment. Lifecycle stages retain progress and
 * persistence policy.
 */
export class EnvironmentRoleRunner {
  private readonly roleBuilder: EnvironmentRoleBuilder;

  constructor(
    private readonly assetStore: Pick<AssetStore, "prepareMount" | "buildCommit">,
    private readonly preflightMounts: EnvironmentMountPreflightBatch,
    private readonly hooks: EnvironmentRoleRunnerHooks = {},
  ) {
    this.roleBuilder = new EnvironmentRoleBuilder(assetStore);
  }

  async runAll(
    plans: readonly EnvironmentRolePlan[],
  ): Promise<EnvironmentRoleRunnerResult> {
    const preparedSettled = await Promise.allSettled(
      plans.map((plan) => this.prepare(plan)),
    );
    const rejectedPreparation = preparedSettled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejectedPreparation) throw rejectedPreparation.reason;

    const prepared = preparedSettled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );
    let preflightByMount: ReadonlyMap<string, AgentServerPreflightReport>;
    try {
      preflightByMount = await this.preflightMounts(
        prepared.map((entry) => entry.mount),
      );
    } catch (error) {
      await Promise.allSettled(
        prepared.map((entry) => this.reportFailure(entry.plan.role, "preflight", error)),
      );
      throw error;
    }

    const completedSettled = await Promise.allSettled(
      prepared.map((entry) => this.complete(entry, preflightByMount)),
    );
    const rejectedCompletion = completedSettled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejectedCompletion) throw rejectedCompletion.reason;

    const agents: EnvironmentRoleRunnerResult = {};
    for (const [index, result] of completedSettled.entries()) {
      if (result.status === "fulfilled") {
        agents[prepared[index]!.plan.role] = result.value;
      }
    }
    return agents;
  }

  private async prepare(plan: EnvironmentRolePlan): Promise<{
    plan: EnvironmentRolePlan;
    mount: CodexMount;
  }> {
    const role = plan.role;
    let step: EnvironmentRoleStep = plan.inspection.decision === "rebuild"
      ? "wipe"
      : "verify";

    await this.hooks.onRoleStart?.(role, plan);

    try {
      const preparation = this.assetStore.prepareMount(plan.options, (nextStep: MountMaterializationStep) => {
        step = nextStep;
      });
      if (preparation.decision !== plan.inspection.decision) {
        throw new Error(
          `Mount preparation changed after verification for ${role}`
          + `: planned=${plan.inspection.decision} actual=${preparation.decision}`,
        );
      }
      if (resolve(preparation.mount.manifestPath) !== resolve(plan.expectedMountManifestPath)) {
        throw new Error(`Current mount manifest path does not match run index for ${role}.`);
      }

      step = "preflight";
      await this.hooks.onPreflightStart?.(role, plan);
      return { plan, mount: preparation.mount };
    } catch (error) {
      await this.reportFailure(role, step, error);
      throw error;
    }
  }

  private async complete(
    prepared: { plan: EnvironmentRolePlan; mount: CodexMount },
    preflightByMount: ReadonlyMap<string, AgentServerPreflightReport>,
  ): Promise<RunAgentEnvironment> {
    const { plan, mount } = prepared;
    const preflight = preflightByMount.get(resolve(mount.mountRoot));
    if (!preflight) {
      const error = new Error(`Mount preflight did not return ${mount.mountRoot}.`);
      await this.reportFailure(plan.role, "preflight", error);
      throw error;
    }
    const agent = this.roleBuilder.build({
      role: plan.role,
      mount,
      preflightPath: plan.preflightPath,
      assetCommitPath: plan.assetCommitPath,
    }, preflight);
    if (agent.assetCommit.status !== "preflight_passed") {
      await this.reportFailure(plan.role, "preflight", agent.preflight.error);
    } else {
      await this.hooks.onRoleComplete?.(plan.role, plan, agent);
    }
    return agent;
  }

  private async reportFailure(
    role: ScoutAgentRole,
    step: EnvironmentRoleStep,
    error?: unknown,
  ): Promise<void> {
    try {
      await this.hooks.onRoleFailure?.(role, step, error);
    } catch {
      // Hooks are observational. Preserve the pipeline's original failure.
    }
  }
}

/** Adapts independent mount checks to the batch contract used by the environment runner. */
export function createEnvironmentMountPreflightBatch(
  preflightMount: (mount: CodexMount) => Promise<AgentServerPreflightReport>,
): EnvironmentMountPreflightBatch {
  return async (mounts) => {
    const settled = await Promise.allSettled(mounts.map(preflightMount));
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) throw rejected.reason;
    const reports = new Map<string, AgentServerPreflightReport>();
    for (const [index, result] of settled.entries()) {
      if (result.status !== "fulfilled") continue;
      const mountRoot = resolve(mounts[index]!.mountRoot);
      if (reports.has(mountRoot)) {
        throw new Error(`Duplicate mount root in preflight batch: ${mountRoot}.`);
      }
      reports.set(mountRoot, result.value);
    }
    return reports;
  };
}

/**
 * Returns human-readable preflight failures without deciding whether a
 * startup or resume stage should fail. Each lifecycle stage owns that policy.
 */
export function describeEnvironmentPreflightFailures(
  agents: EnvironmentRoleRunnerResult,
): string[] {
  return Object.values(agents)
    .filter((agent): agent is RunAgentEnvironment => Boolean(agent))
    .filter((agent) => agent.assetCommit.status !== "preflight_passed")
    .map((agent) => {
      const reasons = [
        ...agent.mount.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => `${issue.code}: ${issue.message}`),
        ...(agent.preflight.rootAccess?.roots ?? [])
          .filter((root) => root.status === "failed")
          .map((root) => `root ${root.path}: ${root.error ?? "failed"}`),
        ...(agent.preflight.shellSmoke ?? [])
          .filter((smoke) => smoke.status === "failed")
          .map((smoke) =>
            `shell ${smoke.command}: ${smoke.error ?? smoke.stderr ?? "failed"}`
          ),
        ...(agent.preflight.pluginGate?.status === "failed"
          ? agent.preflight.pluginGate.plugins
              .filter((plugin) => !plugin.installedAfter || !plugin.enabledAfter)
              .map((plugin) =>
                `plugin ${plugin.pluginName}: installed=${plugin.installedAfter}`
                + ` enabled=${plugin.enabledAfter}`
              )
          : []),
        ...(agent.preflight.error
          ? [`app-server: ${agent.preflight.error.split("\n", 1)[0]}`]
          : []),
      ];
      return `${agent.role} (${reasons.join(", ") || "status=failed"})`;
    });
}
