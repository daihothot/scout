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

export type { MaterializeOptions } from "./mount/context-builder.js";

const defaultMountPreparation = new MountPreparation();
export function materializeCodexMount(options: MaterializeOptions): CodexMount {
  const context = new MountContextBuilder(options).build();
  return new MountMaterializer(context).materialize(options);
}

export function inspectCodexMount(
  options: MaterializeOptions & { persistedManifest?: MountManifest },
): MountPreparationInspection {
  return defaultMountPreparation.inspect(options);
}

export function prepareCodexMount(
  options: MaterializeOptions & { persistedManifest?: MountManifest },
): MountPreparationResult {
  return defaultMountPreparation.prepare(options);
}
