/**
 * Thin public entry points for the asset-store mount pipeline. Resource
 * interpretation, reuse decisions, and filesystem writes remain in their
 * dedicated mount objects.
 */
import type {
  MaterializeOptions,
  MountPreparationInspection,
  MountPreparationResult,
} from "./contracts/materialization.js";
import type { MountManifest } from "./contracts/manifest.js";
import type { CodexMount } from "./contracts/mount.js";
import { MountContextBuilder } from "./builders/mount-context-builder.js";
import { MountMaterializer } from "./mount/materializer.js";
import { MountPreparation } from "./preparation.js";

const defaultMountPreparation = new MountPreparation();

/** Builds a fresh Codex mount from repository assets and runtime options. */
export function materializeCodexMount(options: MaterializeOptions): CodexMount {
  const context = new MountContextBuilder(options).build();
  return new MountMaterializer(context).materialize(options);
}

/** Checks whether the persisted mount can be reused without touching it. */
export function inspectCodexMount(
  options: MaterializeOptions & { persistedManifest?: MountManifest },
): MountPreparationInspection {
  return defaultMountPreparation.inspect(options);
}

/** Reuses a verified mount or rebuilds it, preserving the preparation decision. */
export function prepareCodexMount(
  options: MaterializeOptions & { persistedManifest?: MountManifest },
  observeMaterializationStep?: MaterializeOptions["onMaterializationStep"],
): MountPreparationResult {
  return defaultMountPreparation.prepare(options, observeMaterializationStep);
}
