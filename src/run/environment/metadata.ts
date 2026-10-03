import { summarizeAgentServerPreflight } from "../../agent-server/codex/app-server-preflight.js";
import { sha256Text, stableJson, writeJsonFile } from "../../core/io/index.js";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { runPaths } from "../../core/io/index.js";
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
import { EnvironmentSnapshotLoader } from "./snapshot-loader.js";

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

/** Persists rollback evidence before mount writes and replays it after interruption. */
export class EnvironmentMetadataRollback {
  private readonly recordPath: string;

  constructor(
    private readonly snapshot: EnvironmentSnapshot,
    private readonly manifestStore: RunManifestStore,
    private readonly scoutRoot: string,
  ) {
    this.recordPath = runPaths(dirname(manifestStore.path)).environmentRollbackPath;
  }

  static recoverPending(scoutRoot: string, manifestStore: RunManifestStore): void {
    const snapshot = EnvironmentSnapshotLoader.readRollback(scoutRoot, dirname(manifestStore.path));
    if (snapshot) new EnvironmentMetadataRollback(snapshot, manifestStore, scoutRoot).restore();
  }

  /** The hard-link publication is atomic and refuses to overwrite a pending record. */
  begin(): void {
    const captured = {
      version: 1,
      runId: this.snapshot.manifest.runId,
      manifest: this.snapshot.manifest,
      agents: this.snapshot.agents.map(({ role, mountManifest, assetCommit, preflight }) => ({
        role, mountManifest, assetCommit, preflight,
      })),
    };
    const temporaryPath = `${this.recordPath}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporaryPath, "wx", 0o600);
    try {
      try {
        writeFileSync(descriptor, `${JSON.stringify({
          ...captured,
          checksum: sha256Text(stableJson(captured)),
        }, null, 2)}\n`, "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      linkSync(temporaryPath, this.recordPath);
    } finally {
      unlinkSync(temporaryPath);
    }
  }

  /** Only a fully committed or fully restored environment may retire its evidence. */
  complete(): void {
    unlinkSync(this.recordPath);
  }

  restore(): void {
    // Validate all destinations together before writing any of them. A crash
    // may have removed the mount, but does not authorize following a symlink.
    const snapshot = EnvironmentSnapshotLoader.readRollback(this.scoutRoot, dirname(this.manifestStore.path));
    if (!snapshot) throw new Error(`Environment rollback record is missing: ${this.recordPath}.`);
    const currentManifest = this.manifestStore.read();
    if (currentManifest.runId !== snapshot.manifest.runId) {
      throw new Error("Environment rollback does not belong to the current run.");
    }
    let firstError: unknown;
    for (const persisted of snapshot.agents) {
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
      // Runtime status and checkpoint facts are not owned by the environment.
      this.manifestStore.restore({ ...currentManifest, agents: snapshot.manifest.agents });
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) {
      throw firstError;
    }
    this.complete();
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
      this.input.rollback.complete();
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
