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

export class AssetStore {
  private readonly mountPreparation = new MountPreparation();

  materializeMount(options: MaterializeOptions): CodexMount {
    return materializeCodexMount(options);
  }

  prepareMount(options: MaterializeOptions & { persistedManifest?: MountManifest }): MountPreparationResult {
    return this.mountPreparation.prepare(options);
  }

  inspectMount(options: MaterializeOptions & { persistedManifest?: MountManifest }): MountPreparationInspection {
    return this.mountPreparation.inspect(options);
  }

  buildCommit(options: BuildAssetCommitOptions): AssetCommit {
    return buildAssetCommit(options);
  }

  trustedRootsForMount(mount: CodexMount): string[] {
    return collectMountTrustedRoots(mount);
  }

  writableRootsForMount(mount: CodexMount): string[] {
    return collectMountWritableRoots(mount);
  }
}
