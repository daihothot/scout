import type {
  RuntimeInteractionPort,
  SubprocessProgressDescriptor,
  SubprocessProgressSnapshot,
} from "../../../interaction/protocol/port.js";
import type { MountPreparationProgressState } from "./preparation-state.js";
import { createSubprocessProgressPublisher } from "../subprocess-progress.js";

/**
 * Adapts transport-neutral mount preparation state to the generic subprocess
 * progress channel. Lifecycle stages own all state transitions and sequencing.
 */
export function createMountPreparationProgressPublisher(
  interactionPort: RuntimeInteractionPort,
  options: {
    id?: string;
    describe?: (progress: MountPreparationProgressState) => SubprocessProgressDescriptor;
  } = {},
): (progress: MountPreparationProgressState) => Promise<void> {
  const publisher = createSubprocessProgressPublisher(interactionPort);
  return (progress) => publisher.publish(toSubprocessProgressSnapshot(
    progress,
    options.id ?? "mount-preparation",
    options.describe ?? describeMountPreparationProgress,
  ));
}

/** Converts a mutable stage progress state into an immutable interaction snapshot. */
export function toSubprocessProgressSnapshot(
  progress: MountPreparationProgressState,
  id = "mount-preparation",
  describe: (progress: MountPreparationProgressState) => SubprocessProgressDescriptor =
    describeMountPreparationProgress,
): SubprocessProgressSnapshot {
  return {
    id,
    phase: progress.phase === "failed"
      ? "failed"
      : progress.phase === "done" ? "done" : "running",
    completedUnits: progress.completedUnits,
    totalUnits: progress.totalUnits,
    descriptor: describe(progress),
  };
}

/** Builds the default interaction descriptor for mount preparation progress. */
export function describeMountPreparationProgress(
  progress: MountPreparationProgressState,
): SubprocessProgressDescriptor {
  const status = progress.phase === "failed"
    ? {
      marker: "!",
      label: "Mount preparation failed",
      detail: `${progress.activeRole ?? "mount"}${progress.activeStep ? ` ${progress.activeStep}` : ""}`,
      tone: "failed" as const,
    }
    : {
      marker: "*",
      label: "Preparing Scout runtime",
      detail: mountStatusDetail(progress),
      tone: "active" as const,
    };
  if (progress.phase !== "rebuild") return { status };
  return {
    status,
    progress: {
      marker: "▷",
      label: progress.activeRole ?? "mount",
      detail: progress.activeStep && progress.activeStep !== "verify"
        ? progress.activeStep
        : undefined,
      units: `${progress.completedUnits}/${progress.totalUnits}`,
      tone: "active",
    },
  };
}

function mountStatusDetail(progress: MountPreparationProgressState): string {
  if (progress.phase === "rebuild") {
    return `Mount · ${progress.activeStep ?? "rebuilding"}${progress.activeRole ? ` · ${progress.activeRole}` : ""}`;
  }
  if (progress.phase === "done") {
    return `Mount · ready · ${reusableRoleCount(progress)}/${progress.roles.length} reusable`;
  }
  if (progress.activeStep === "preflight" && progress.activeRole) {
    return `Mount · preflight · ${progress.activeRole}`;
  }
  const planned = progress.roles.filter((role) => role.decision !== "pending").length;
  return planned === progress.roles.length && progress.roles.length > 0
    ? `Mount · verifying · ${reusableRoleCount(progress)}/${progress.roles.length} reusable`
    : "Mount · verifying";
}

function reusableRoleCount(progress: MountPreparationProgressState): number {
  return progress.roles.filter((role) => role.decision === "reused").length;
}
