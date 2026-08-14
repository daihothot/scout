/**
 * Observable decisions and steps produced while a mount is inspected or
 * materialized. Filesystem work and lifecycle progress adapters live elsewhere.
 */
import type { CodexMount } from "./mount.js";
import type { PersistedMountIdentity } from "./identity.js";
import type { MountManifest } from "./manifest.js";

/** Inputs that identify one role and control inspect/materialize observation. */
export interface MaterializeOptions {
  scoutRoot: string;
  runId?: string;
  agentId: string;
  persistedManifest?: MountManifest;
  parentAssetCommitId?: string;
  persistedIdentity?: PersistedMountIdentity;
  allowLegacyResourceIdentityMigration?: boolean;
  cleanRunRoot?: boolean;
  onPreparationDecision?(decision: MountPreparationDecision, reason?: string): void;
  onMaterializationStep?(step: MountMaterializationStep): void;
}

/** Outcome of comparing an existing mount against the current portable context. */
export type MountPreparationDecision = "reused" | "rebuild";

/** Reuse decision plus a diagnostic reason when rebuilding is required. */
export interface MountPreparationInspection {
  decision: MountPreparationDecision;
  reason?: string;
}

/** Filesystem materialization phases reported by the asset store. */
export type MountMaterializationStep =
  | "wipe"
  | "layout"
  | "config"
  | "skills"
  | "plugins"
  | "shell";

/** Mount projection returned after inspection and optional materialization. */
export interface MountPreparationResult {
  mount: CodexMount;
  decision: MountPreparationDecision;
  reason?: string;
}
