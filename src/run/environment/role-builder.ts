import type { AgentServerPreflightReport } from "../../agent-server/types.js";
import type {
  AssetStore,
  CodexMount,
} from "../../asset-store/index.js";
import type { ScoutAgentRole } from "../../agent/thread/types.js";
import type { RunAgentEnvironment } from "../types.js";

/**
 * Describes the prepared mount and artifact destinations required to assemble
 * one in-memory role environment.
 */
export interface EnvironmentRoleBuildPlan {
  role: ScoutAgentRole;
  mount: CodexMount;
  preflightPath: string;
  assetCommitPath: string;
}

/**
 * Builds the common in-memory role environment after a stage has prepared and
 * validated its mount. It does not publish progress or persist any artifact.
 */
export class EnvironmentRoleBuilder {
  constructor(
    private readonly assetStore: Pick<AssetStore, "buildCommit">,
    private readonly preflightMount: (mount: CodexMount) => Promise<AgentServerPreflightReport>,
  ) {}

  async build(plan: EnvironmentRoleBuildPlan): Promise<RunAgentEnvironment> {
    const { mount } = plan;
    const preflight = await this.preflightMount(mount);
    const preflightStatus = mount.issues.some((issue) => issue.severity === "error")
      ? "failed"
      : preflight.status;
    const assetCommit = this.assetStore.buildCommit({
      mount,
      preflightStatus,
      preflightPath: plan.preflightPath,
    });
    return {
      role: plan.role,
      mount,
      preflight,
      preflightPath: plan.preflightPath,
      assetCommit,
      assetCommitPath: plan.assetCommitPath,
    };
  }
}
