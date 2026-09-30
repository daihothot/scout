import {
  AgentTaskStatuses,
  type AgentTaskState,
} from "../../../agent/task/types.js";
import { AgentStepStatuses } from "../../../agent/step/types.js";
import { projectedStepsForTask, type RunProjection } from "./run-projector.js";

/** Ordered recovery checkpoints inferred from persisted task and turn facts. */
export const TaskRecoveryCheckpoints = {
  Queued: "task_queued",
  Resumable: "task_resumable",
  WaitingForHumanInput: "waiting_for_human_input",
  Interrupted: "task_interrupted",
  OutcomeSubmitted: "outcome_submitted",
  Terminated: "task_terminated",
} as const;
/** String union consumed by packet schemas and resume-stage decisions. */
export type TaskRecoveryCheckpoint =
  typeof TaskRecoveryCheckpoints[keyof typeof TaskRecoveryCheckpoints];

/**
 * Infers the highest-priority recovery boundary for a task. Terminal status
 * wins first, then unresolved human input, queued state, interrupted steps or
 * turns, and finally a resumable task; `undefined` means no task exists.
 */
export function inferTaskRecoveryCheckpoint(
  projection: RunProjection,
  task: AgentTaskState | undefined,
): TaskRecoveryCheckpoint | undefined {
  if (!task) return undefined;
  if (task.status === AgentTaskStatuses.Done) {
    return TaskRecoveryCheckpoints.OutcomeSubmitted;
  }
  if (
    task.status === AgentTaskStatuses.Failed
    || task.status === AgentTaskStatuses.Stopped
  ) {
    return TaskRecoveryCheckpoints.Terminated;
  }
  const unresolvedHumanRequest = projection.humanInputRequests.some((request) =>
    request.taskId === task.taskId && !request.response
  );
  if (unresolvedHumanRequest) return TaskRecoveryCheckpoints.WaitingForHumanInput;
  if (task.status === AgentTaskStatuses.Queued) return TaskRecoveryCheckpoints.Queued;
  const currentStep = projectedStepsForTask(projection, task).at(-1);
  if (
    currentStep?.status === AgentStepStatuses.Running
    || currentStep?.status === AgentStepStatuses.Interrupted
  ) {
    return TaskRecoveryCheckpoints.Interrupted;
  }
  const interruptedTurn = projection.turns.some((turn) =>
    turn.taskId === task.taskId
    && (turn.completedAt === undefined || turn.status === "interrupted")
  );
  return interruptedTurn
    ? TaskRecoveryCheckpoints.Interrupted
    : TaskRecoveryCheckpoints.Resumable;
}
