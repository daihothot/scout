import { buildAssetCommit, type BuildAssetCommitOptions } from "./commit.js";
import { materializeCodexMount, type MaterializeOptions } from "./materialize.js";
import { collectMountTrustedRoots, collectMountWritableRoots } from "./preflight.js";
import type { AssetCommit, CodexMount } from "./types.js";

export class AssetStore {
  materializeMount(options: MaterializeOptions): CodexMount {
    return materializeCodexMount(options);
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
