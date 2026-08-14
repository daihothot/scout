import type { ScoutAgentRole } from "../../../agent/thread/types.js";
import type {
  MountMaterializationStep,
  MountPreparationDecision,
} from "../../../asset-store/contracts/materialization.js";

/** Per-role outcome tracked while mounts are verified or rebuilt. */
export type MountPreparationRoleDecision = "pending" | "reused" | "rebuild" | "failed";

/** Visible units that translate mount preparation into subprocess progress. */
export type MountPreparationStep =
  | "verify"
  | "wipe"
  | "layout"
  | "config"
  | "skills"
  | "plugins"
  | "shell"
  | "preflight";

/**
 * Mutable mount preparation state consumed by lifecycle progress publishers.
 * It contains no TUI layout or transport behavior.
 */
export interface MountPreparationProgressState {
  phase: "verify" | "rebuild" | "done" | "failed";
  activeRole?: ScoutAgentRole;
  activeStep?: MountPreparationStep;
  roles: Array<{
    role: ScoutAgentRole;
    decision: MountPreparationRoleDecision;
    step?: MountPreparationStep;
    reason?: string;
  }>;
  completedUnits: number;
  totalUnits: number;
}

const REBUILD_EXTRA_UNITS = 5;
const REBUILD_UNITS = REBUILD_EXTRA_UNITS + 1;

/** Starts verification with one provisional unit for every requested role. */
export function createMountPreparationProgress(
  roles: readonly ScoutAgentRole[],
): MountPreparationProgressState {
  return {
    phase: "verify",
    roles: roles.map((role) => ({ role, decision: "pending" })),
    completedUnits: 0,
    totalUnits: roles.length,
  };
}

/** Freeze preparation decisions before materialization starts. */
export function planMountPreparation(
  progress: MountPreparationProgressState,
  decisions: ReadonlyMap<ScoutAgentRole, {
    decision: MountPreparationDecision;
    reason?: string;
  }>,
): void {
  let totalUnits = 0;
  let completedUnits = 0;
  let rebuilding = false;
  for (const entry of progress.roles) {
    const planned = decisions.get(entry.role);
    if (!planned) throw new Error(`Mount preparation has no decision for ${entry.role}`);
    entry.decision = planned.decision === "reused" ? "reused" : "pending";
    entry.step = undefined;
    entry.reason = planned.reason;
    if (planned.decision === "rebuild") {
      totalUnits += REBUILD_UNITS;
      rebuilding = true;
    } else {
      totalUnits += 1;
      completedUnits += 1;
    }
  }
  progress.totalUnits = totalUnits;
  progress.completedUnits = completedUnits;
  progress.phase = rebuilding ? "rebuild" : "verify";
  progress.activeRole = rebuilding
    ? progress.roles.find((entry) => entry.decision === "pending")?.role
    : undefined;
  progress.activeStep = undefined;
}

/**
 * Records the preparation decision emitted while a role is inspected or run.
 * Unplanned rebuilds expand the total because their extra work was not known
 * when the progress state was created.
 */
export function applyMountPreparationDecision(
  progress: MountPreparationProgressState,
  role: ScoutAgentRole,
  decision: MountPreparationDecision,
  reason?: string,
  planned = false,
): void {
  if (progress.phase === "failed") return;
  const entry = roleEntry(progress, role);
  if (entry.decision === decision) {
    if (reason) entry.reason = reason;
    return;
  }
  progress.activeRole = role;
  progress.activeStep = undefined;
  entry.decision = decision;
  entry.step = undefined;
  entry.reason = reason;
  if (planned) return;
  if (decision === "reused") {
    progress.completedUnits += 1;
    return;
  }
  progress.phase = "rebuild";
  progress.totalUnits += REBUILD_EXTRA_UNITS;
}

/** Advances the visible rebuild units for one materialization callback. */
export function applyMountMaterializationStep(
  progress: MountPreparationProgressState,
  role: ScoutAgentRole,
  step: MountMaterializationStep,
): void {
  if (progress.phase === "failed") return;
  const entry = roleEntry(progress, role);
  progress.phase = "rebuild";
  progress.activeRole = role;
  progress.activeStep = step;
  entry.decision = "rebuild";
  entry.step = step;
  // Skills and plugins share one visible unit in the mount descriptor.
  if (step !== "plugins") progress.completedUnits += 1;
}

/** Completes the preflight unit after the role builder returns. */
export function applyMountPreflightStep(
  progress: MountPreparationProgressState,
  role: ScoutAgentRole,
): void {
  if (progress.phase === "failed") return;
  const entry = roleEntry(progress, role);
  progress.phase = "rebuild";
  progress.activeRole = role;
  progress.activeStep = "preflight";
  entry.step = "preflight";
  progress.completedUnits += 1;
}

/** Selects preflight as the active step without completing its progress unit. */
export function beginMountPreflightStep(
  progress: MountPreparationProgressState,
  role: ScoutAgentRole,
): void {
  if (progress.phase === "failed") return;
  const entry = roleEntry(progress, role);
  progress.activeRole = role;
  progress.activeStep = "preflight";
  entry.step = "preflight";
}

/** Clears the active marker after one role finishes without changing totals. */
export function completeMountRole(
  progress: MountPreparationProgressState,
  role: ScoutAgentRole,
): void {
  if (progress.phase === "failed") return;
  const entry = roleEntry(progress, role);
  entry.step = undefined;
  entry.reason = undefined;
  if (progress.activeRole === role) {
    progress.activeRole = undefined;
    progress.activeStep = undefined;
  }
}

/** Freezes the operation at the first role failure and retains a short reason. */
export function failMountRole(
  progress: MountPreparationProgressState,
  role: ScoutAgentRole,
  step: MountPreparationStep,
  reason?: string,
): void {
  if (progress.phase === "failed") return;
  const entry = roleEntry(progress, role);
  progress.phase = "failed";
  progress.activeRole = role;
  progress.activeStep = step;
  entry.decision = "failed";
  entry.step = step;
  entry.reason = shortReason(reason);
}

/** Marks the operation complete and clears any active role or step. */
export function finishMountPreparation(progress: MountPreparationProgressState): void {
  progress.phase = "done";
  progress.activeRole = undefined;
  progress.activeStep = undefined;
}

function roleEntry(
  progress: MountPreparationProgressState,
  role: ScoutAgentRole,
): {
  role: ScoutAgentRole;
  decision: MountPreparationRoleDecision;
  step?: MountPreparationStep;
  reason?: string;
} {
  const entry = progress.roles.find((candidate) => candidate.role === role);
  if (!entry) throw new Error(`Mount preparation progress has no role: ${role}`);
  return entry;
}

function shortReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return reason.split("\n", 1)[0]?.slice(0, 180);
}
