import type {
  AssetCommit,
  MaterializeOptions,
  MountManifest,
  MountMaterializationStep,
  MountPreparationInspection,
} from "../../asset-store/index.js";
import type { AgentServerPreflightReport } from "../../agent-server/types.js";
import type { ScoutAgentRole } from "../../agent/thread/types.js";
import type { RunAgentEnvironment } from "../types.js";
import type { RunManifest } from "../persistence/index.js";

/** Steps emitted by environment capabilities. UI adapters may map these to a
 * presentation-specific progress model. */
export type EnvironmentRoleStep =
  | "verify"
  | MountMaterializationStep
  | "preflight";

/** The persisted facts needed to reconstruct one role environment. */
export interface PersistedEnvironmentAgent {
  readonly role: ScoutAgentRole;
  readonly mountManifestPath: string;
  readonly assetCommitPath: string;
  readonly preflightPath: string;
  readonly mountManifest: MountManifest;
  readonly assetCommit: AssetCommit;
  readonly preflight: AgentServerPreflightReport;
  /** Legacy inventories are migrated only after the caller commits metadata. */
  readonly allowLegacyResourceIdentityMigration: boolean;
}

/** A validated persisted environment, independent of the lifecycle stage that
 * requested it. */
export interface EnvironmentSnapshot {
  readonly manifest: RunManifest;
  readonly agents: readonly PersistedEnvironmentAgent[];
}

/** Input assembled by a stage before mount inspection. */
export interface EnvironmentRolePreparationInput {
  readonly role: ScoutAgentRole;
  readonly options: MaterializeOptions;
  readonly expectedMountManifestPath: string;
  readonly assetCommitPath: string;
  readonly preflightPath: string;
}

/** Frozen result of inspecting one role mount. */
export interface EnvironmentRolePlan extends EnvironmentRolePreparationInput {
  readonly inspection: MountPreparationInspection;
}

/**
 * Observational callbacks around one role pipeline. Hook failures must not
 * replace the pipeline failure reported by the runner.
 */
export interface EnvironmentRoleRunnerHooks {
  onRoleStart?(role: ScoutAgentRole, plan: EnvironmentRolePlan): Promise<void> | void;
  onPreflightStart?(role: ScoutAgentRole, plan: EnvironmentRolePlan): Promise<void> | void;
  onRoleComplete?(
    role: ScoutAgentRole,
    plan: EnvironmentRolePlan,
    agent: RunAgentEnvironment,
  ): Promise<void> | void;
  onRoleFailure?(
    role: ScoutAgentRole,
    step: EnvironmentRoleStep,
    error?: unknown,
  ): Promise<void> | void;
}

/** A batch may be run for a subset of Scout roles during startup. */
export type EnvironmentRoleRunnerResult = Partial<
  Record<ScoutAgentRole, RunAgentEnvironment>
>;

/**
 * Narrows a partial batch result after asserting that every requested role
 * completed. Lifecycle stages use this before constructing a run environment.
 */
export function requireEnvironmentAgents(
  agents: EnvironmentRoleRunnerResult,
  roles: readonly ScoutAgentRole[],
): Record<ScoutAgentRole, RunAgentEnvironment> {
  const result: Partial<Record<ScoutAgentRole, RunAgentEnvironment>> = {};
  for (const role of roles) {
    const agent = agents[role];
    if (!agent) throw new Error(`Run environment did not produce ${role}.`);
    result[role] = agent;
  }
  return result as Record<ScoutAgentRole, RunAgentEnvironment>;
}
