import { buildAssetCommit, type BuildAssetCommitOptions } from "./commit.js";
import {
  materializeCodexMount,
  type MaterializeOptions,
} from "./materialize.js";
import { MountPreparation } from "./mount/preparation.js";
import { collectMountTrustedRoots, collectMountWritableRoots } from "./mount/preflight.js";
import type {
  AssetCommit,
  CodexMount,
  MountManifest,
  MountPreparationInspection,
  MountPreparationResult,
} from "./types.js";

/**
 * Public asset-store facade used by run stages. It delegates resource reading,
 * mount inspection/materialization, commit construction, and effective root
 * collection; lifecycle ordering and persistence remain owned by the stages.
 */
export class AssetStore {
  private readonly mountPreparation = new MountPreparation();

  /** Materializes a role mount from the current repository assets. */
  materializeMount(options: MaterializeOptions): CodexMount {
    return materializeCodexMount(options);
  }

  /** Inspects a persisted mount and either reuses or rebuilds it as one unit. */
  prepareMount(options: MaterializeOptions & { persistedManifest?: MountManifest }): MountPreparationResult {
    return this.mountPreparation.prepare(options);
  }

  /** Performs the inexpensive decision pass without mutating the mount root. */
  inspectMount(options: MaterializeOptions & { persistedManifest?: MountManifest }): MountPreparationInspection {
    return this.mountPreparation.inspect(options);
  }

  /** Creates the persisted asset-commit projection after mount preflight. */
  buildCommit(options: BuildAssetCommitOptions): AssetCommit {
    return buildAssetCommit(options);
  }

  /** Returns the trusted roots declared by the mount and its MCP servers. */
  trustedRootsForMount(mount: CodexMount): string[] {
    return collectMountTrustedRoots(mount);
  }

  /** Returns the writable roots declared by the mount and its MCP servers. */
  writableRootsForMount(mount: CodexMount): string[] {
    return collectMountWritableRoots(mount);
  }
}
