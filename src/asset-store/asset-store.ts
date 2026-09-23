import { buildAssetCommit, type BuildAssetCommitOptions } from "./builders/asset-commit-builder.js";
import { join, resolve } from "node:path";
import type { AssetCommit } from "./contracts/asset-commit.js";
import type { MountManifest } from "./contracts/manifest.js";
import type {
  MaterializeOptions,
  MountPreparationInspection,
  MountPreparationResult,
} from "./contracts/materialization.js";
import type { CodexMount } from "./contracts/mount.js";
import type { GraphState } from "../core/workflow/index.js";
import { readWorkflowProfile } from "./assets/workflow-profiles.js";
import { WorkflowBuilder } from "./builders/workflow-builder.js";
import { materializeCodexMount } from "./materialize.js";
import { MountPreparation } from "./preparation.js";
import {
  collectMountReadableRoots,
  collectMountWritableRoots,
} from "./mount/preflight.js";
import { AssetJsonReader } from "./files/asset-json-reader.js";

/**
 * Public asset-store facade used by run stages. It delegates resource reading,
 * mount inspection/materialization, commit construction, and effective root
 * collection; lifecycle ordering and persistence remain owned by the stages.
 */
export class AssetStore {
  private readonly mountPreparation = new MountPreparation();

  /** Returns a JSON reader rooted at all Scout-owned assets for one checkout. */
  json(scoutRoot: string): AssetJsonReader {
    return new AssetJsonReader(join(resolve(scoutRoot), "assets", "scout"));
  }

  /** Materializes a role mount from the current repository assets. */
  materializeMount(options: MaterializeOptions): CodexMount {
    return materializeCodexMount(options);
  }

  /** Inspects a persisted mount and either reuses or rebuilds it as one unit. */
  prepareMount(
    options: MaterializeOptions & { persistedManifest?: MountManifest },
    observeMaterializationStep?: MaterializeOptions["onMaterializationStep"],
  ): MountPreparationResult {
    return this.mountPreparation.prepare(options, observeMaterializationStep);
  }

  /** Performs the inexpensive decision pass without mutating the mount root. */
  inspectMount(options: MaterializeOptions & { persistedManifest?: MountManifest }): MountPreparationInspection {
    return this.mountPreparation.inspect(options);
  }

  /** Creates the persisted asset-commit projection after mount preflight. */
  buildCommit(options: BuildAssetCommitOptions): AssetCommit {
    return buildAssetCommit(options);
  }

  /** Returns the Agent-shell readable roots owned by runtime and the role profile. */
  readableRootsForMount(mount: CodexMount): string[] {
    return collectMountReadableRoots(mount);
  }

  /** Returns the writable roots declared by the mount and its MCP servers. */
  writableRootsForMount(mount: CodexMount): string[] {
    return collectMountWritableRoots(mount);
  }

  /** Reads the selected Workflow Profile and builds its initial graph state. */
  buildWorkflow(scoutRoot: string, profileName: string): GraphState {
    return new WorkflowBuilder(readWorkflowProfile(scoutRoot, profileName)).build();
  }
}
