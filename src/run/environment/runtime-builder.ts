import { ScoutAgentRoles, type ScoutAgentRole } from "../../agent/thread/types.js";
import type { AssetStore } from "../../asset-store/index.js";
import { buildRunRootAccess } from "../root-access.js";
import {
  buildRunContextBundle,
  type RunAgentEnvironment,
  type RunEnvironment,
} from "../types.js";

/**
 * Builds the run-wide environment after a stage has completed mount,
 * preflight, and persistence policy. It derives root access and the shared
 * context bundle but does not materialize mounts or write run metadata.
 */
export class RunEnvironmentBuilder {
  constructor(
    private readonly assetStore: Pick<
      AssetStore,
      "readableRootsForMount" | "writableRootsForMount"
    >,
  ) {}

  build(input: {
    runId: string;
    agents: Record<ScoutAgentRole, RunAgentEnvironment>;
  }): RunEnvironment {
    const agents = input.agents;
    const coordinator = agents[ScoutAgentRoles.Coordinator];
    if (!coordinator) {
      throw new Error("Run environment requires a coordinator agent.");
    }
    return {
      agents,
      rootAccess: buildRunRootAccess(this.assetStore, agents),
      contextBundle: buildRunContextBundle({
        runId: input.runId,
        assetCommit: coordinator.assetCommit,
      }),
    };
  }
}
