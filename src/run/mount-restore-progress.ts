import type { ScoutAgentRole } from "../agent/thread/types.js";
import type {
  MountMaterializationStep,
  MountPreparationDecision,
} from "../asset-store/types.js";
import type {
  MountRestoreProgress,
  MountRestoreRoleDecision,
  MountRestoreStep,
} from "../interaction/protocol/port.js";
import type { RuntimeInteractionPort } from "../interaction/protocol/port.js";

const REBUILD_EXTRA_UNITS = 5;
const REBUILD_UNITS = REBUILD_EXTRA_UNITS + 1;

export function createMountRestoreProgress(
  roles: readonly ScoutAgentRole[],
): MountRestoreProgress {
  return {
    phase: "verify",
    roles: roles.map((role) => ({ role, decision: "pending" })),
    completedUnits: 0,
    totalUnits: roles.length,
  };
}

/**
 * Freezes the role decisions before materialization starts so the progress
 * denominator cannot move while the bar is visible.
 */
export function planMountRestore(
  progress: MountRestoreProgress,
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
    if (!planned) throw new Error(`Mount restore has no preparation decision for ${entry.role}`);
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

export function applyMountPreparationDecision(
  progress: MountRestoreProgress,
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

export function applyMountMaterializationStep(
  progress: MountRestoreProgress,
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
  // plugins is reported together with skills; the other materialization
  // callbacks each complete one visible unit.
  if (step !== "plugins") progress.completedUnits += 1;
}

export function applyMountPreflightStep(
  progress: MountRestoreProgress,
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

export function beginMountPreflightStep(
  progress: MountRestoreProgress,
  role: ScoutAgentRole,
): void {
  if (progress.phase === "failed") return;
  const entry = roleEntry(progress, role);
  progress.activeRole = role;
  progress.activeStep = "preflight";
  entry.step = "preflight";
}

export function completeMountRole(
  progress: MountRestoreProgress,
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

export function failMountRole(
  progress: MountRestoreProgress,
  role: ScoutAgentRole,
  step: MountRestoreStep,
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

export function finishMountRestore(
  progress: MountRestoreProgress,
): void {
  progress.phase = "done";
  progress.activeRole = undefined;
  progress.activeStep = undefined;
}

export async function discloseMountRestoreFailure(
  interactionPort: RuntimeInteractionPort,
  role: ScoutAgentRole,
  step: MountRestoreStep,
  reason?: string,
): Promise<void> {
  const detail = shortReason(reason);
  try {
    await interactionPort.disclose({
      level: "error",
      source: "run.mount-restore",
      message: `Mount restore failed · ${role} ${step}${detail ? `: ${detail}` : ""}`,
    });
  } catch {
    // Disclosure is observational; preserve the original stage failure.
  }
}

function roleEntry(
  progress: MountRestoreProgress,
  role: ScoutAgentRole,
): {
  role: ScoutAgentRole;
  decision: MountRestoreRoleDecision;
  step?: MountRestoreStep;
  reason?: string;
} {
  const entry = progress.roles.find((candidate) => candidate.role === role);
  if (!entry) throw new Error(`Mount restore progress has no role: ${role}`);
  return entry;
}

function shortReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return reason.split("\n", 1)[0]?.slice(0, 180);
}
