/**
 * Thin public entry points for the asset-store mount pipeline. Resource
 * interpretation, reuse decisions, and filesystem writes remain in their
 * dedicated mount objects.
 */
import type {
  CodexMount,
  MountManifest,
  MountPreparationInspection,
  MountPreparationResult,
} from "./types.js";
import {
  MountContextBuilder,
  type MaterializeOptions,
} from "./mount/context-builder.js";
import { MountMaterializer } from "./mount/materializer.js";
import { MountPreparation } from "./mount/preparation.js";

/** Re-export of the options contract accepted by the mount pipeline. */
export type { MaterializeOptions } from "./mount/context-builder.js";

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
): MountPreparationResult {
  return defaultMountPreparation.prepare(options);
}
