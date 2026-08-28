import { summarizeAgentServerPreflight } from "../../agent-server/codex/app-server-preflight.js";
import { writeJsonFile } from "../../core/fs.js";
import { relative, resolve } from "node:path";
import type {
  RunAgentManifestEntry,
  RunManifest,
  RunManifestStore,
} from "../persistence/index.js";
import type { ScoutAgentRole } from "../../agent/thread/types.js";
import type { RunAgentEnvironment } from "../types.js";
import type {
  EnvironmentRoleRunnerResult,
  EnvironmentSnapshot,
} from "./types.js";

/**
 * Persists the two role artifacts whose content is produced by the shared
 * mount/preflight pipeline. Run identity indexing is coordinated by the
 * metadata transaction below so rebuilt mounts cannot drift from run.json.
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
  constructor(
    private readonly snapshot: EnvironmentSnapshot,
    private readonly manifestStore: RunManifestStore,
  ) {}

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
    try {
      this.manifestStore.restore(this.snapshot.manifest);
    } catch (error) {
      firstError ??= error;
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
      readonly manifestStore: RunManifestStore;
      readonly runRoot: string;
    },
  ) {}

  commit(agents: EnvironmentRoleRunnerResult): void {
    try {
      this.writer.write(agents);
      this.input.manifestStore.update((manifest) => ({
        ...manifest,
        agents: updateManifestAgents(manifest, agents, this.input.runRoot),
      }));
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

function updateManifestAgents(
  manifest: RunManifest,
  agents: EnvironmentRoleRunnerResult,
  runRoot: string,
): Record<ScoutAgentRole, RunAgentManifestEntry> {
  if (!manifest.agents) {
    throw new Error(`Run ${manifest.runId} has no persisted agent index.`);
  }
  const next = { ...manifest.agents };
  for (const [role, agent] of Object.entries(agents) as Array<[
    ScoutAgentRole,
    RunAgentEnvironment | undefined,
  ]>) {
    if (!agent) continue;
    const existing = next[role];
    next[role] = {
      ...(existing ?? {
        mountManifestRef: relative(resolve(runRoot), agent.mount.manifestPath),
        assetCommitRef: relative(resolve(runRoot), agent.assetCommitPath),
        preflightRef: relative(resolve(runRoot), agent.preflightPath),
      }),
      mountId: agent.mount.mountId,
      assetCommitId: agent.assetCommit.assetCommitId,
      resourceHash: agent.assetCommit.resourceHash,
    };
  }
  return next;
}
