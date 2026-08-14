import { summarizeAgentServerPreflight } from "../../agent-server/codex/app-server-preflight.js";
import { writeJsonFile } from "../../core/fs.js";
import type { RunAgentEnvironment } from "../types.js";
import type {
  EnvironmentRoleRunnerResult,
  EnvironmentSnapshot,
} from "./types.js";

/**
 * Persists the two role artifacts whose content is produced by the shared
 * mount/preflight pipeline. It does not update the run index; that policy is
 * owned by the lifecycle stage because startup and resume update different
 * manifest fields.
 */
export class EnvironmentArtifactWriter {
  write(agents: EnvironmentRoleRunnerResult): void {
    for (const agent of Object.values(agents)) {
      if (!agent) continue;
      writeJsonFile(
        agent.preflightPath,
        summarizeAgentServerPreflight(agent.preflight, agent.mount),
      );
      writeJsonFile(agent.assetCommitPath, agent.assetCommit);
    }
  }
}

/** Restores the persisted role artifacts captured by the snapshot loader. */
export class EnvironmentMetadataRollback {
  constructor(private readonly snapshot: EnvironmentSnapshot) {}

  restore(): void {
    let firstError: unknown;
    for (const persisted of this.snapshot.agents) {
      for (const [path, value] of [
        [persisted.mountManifestPath, persisted.mountManifest],
        [persisted.assetCommitPath, persisted.assetCommit],
        [persisted.preflightPath, persisted.preflight],
      ] as const) {
        try {
          writeJsonFile(path, value);
        } catch (error) {
          firstError ??= error;
        }
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  }
}

/** Coordinates artifact writes with rollback of the persisted role metadata. */
export class EnvironmentMetadataTransaction {
  private readonly writer = new EnvironmentArtifactWriter();

  constructor(
    private readonly input: {
      readonly rollback: EnvironmentMetadataRollback;
    },
  ) {}

  commit(agents: EnvironmentRoleRunnerResult): void {
    try {
      this.writer.write(agents);
    } catch (error) {
      try {
        this.input.rollback.restore();
      } catch (rollbackError) {
        // Keep the operation error as the primary failure while retaining the
        // rollback failure for callers that need to disclose it.
        if (error instanceof Error) {
          Object.defineProperty(error, "rollbackError", {
            configurable: true,
            enumerable: false,
            value: rollbackError,
          });
        }
      }
      throw error;
    }
  }
}

/** Narrow helper for stages that need to persist one completed role eagerly. */
export function writeEnvironmentAgentArtifacts(agent: RunAgentEnvironment): void {
  new EnvironmentArtifactWriter().write({ [agent.role]: agent });
}
