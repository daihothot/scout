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
} from "./types.js";

/**
 * Executes the common per-role environment pipeline. Lifecycle stages provide
 * the plan, preflight implementation, and observational hooks; this class has
 * no run scope, interaction port, or persistence policy of its own.
 */
export class EnvironmentRoleRunner {
  private readonly roleBuilder: EnvironmentRoleBuilder;

  constructor(
    private readonly assetStore: Pick<AssetStore, "prepareMount" | "buildCommit">,
    private readonly preflightMount: (mount: CodexMount) => Promise<AgentServerPreflightReport>,
    private readonly hooks: EnvironmentRoleRunnerHooks = {},
  ) {
    this.roleBuilder = new EnvironmentRoleBuilder(assetStore, preflightMount);
  }

  async runAll(
    plans: readonly EnvironmentRolePlan[],
  ): Promise<EnvironmentRoleRunnerResult> {
    const settled = await Promise.allSettled(plans.map((plan) => this.run(plan)));
    const rejectedRole = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejectedRole) throw rejectedRole.reason;

    const agents: EnvironmentRoleRunnerResult = {};
    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled") {
        agents[plans[index]!.role] = result.value;
      }
    }
    return agents;
  }

  private async run(plan: EnvironmentRolePlan): Promise<RunAgentEnvironment> {
    const role = plan.role;
    let step: EnvironmentRoleStep = plan.inspection.decision === "rebuild"
      ? "wipe"
      : "verify";
    let failureReported = false;

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
      const agent = await this.roleBuilder.build({
        role,
        mount: preparation.mount,
        preflightPath: plan.preflightPath,
        assetCommitPath: plan.assetCommitPath,
      });
      if (agent.assetCommit.status !== "preflight_passed") {
        failureReported = true;
        await this.reportFailure(role, "preflight", agent.preflight.error);
      } else {
        await this.hooks.onRoleComplete?.(role, plan, agent);
      }
      return agent;
    } catch (error) {
      if (!failureReported) await this.reportFailure(role, step, error);
      throw error;
    }
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
