import {
  AgentTaskStatuses,
  type AgentTaskState,
} from "../../../agent/task/types.js";
import { AgentStepStatuses } from "../../../agent/step/types.js";
import {
  ScoutAgentRoles,
  type ScoutAgentRole,
} from "../../../agent/thread/types.js";
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

/** Discriminants for actions a resumed agent may be asked to inspect or run. */
export const ResumeActionTypes = {
  ResumeTask: "resume_task",
  ConsumeMessage: "consume_message",
  InspectInterruption: "inspect_interruption",
  EvaluateOutcome: "evaluate_outcome",
  ResolveTermination: "resolve_termination",
} as const;
/** Internal, side-effect-free action plan derived from a run projection. */
export type ResumeActionType =
  typeof ResumeActionTypes[keyof typeof ResumeActionTypes];

/**
 * Declarative recovery work selected for one agent. The action carries only a
 * stable identifier; execution remains in the agent/resume orchestration
 * layer, so constructing this union cannot mutate the run.
 */
export type ResumeAction =
  | {
    type: typeof ResumeActionTypes.ResumeTask;
    taskId: string;
  }
  | {
    type: typeof ResumeActionTypes.ConsumeMessage;
    messageId: string;
  }
  | {
    type: typeof ResumeActionTypes.InspectInterruption;
    taskId: string;
  }
  | {
    type: typeof ResumeActionTypes.EvaluateOutcome;
    taskId: string;
  }
  | {
    type: typeof ResumeActionTypes.ResolveTermination;
    taskId: string;
  };

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

/**
 * Plans pending-message consumption and role-specific task actions. The
 * coordinator evaluates a completed task only when its outcome or related
 * validation facts have not already been covered by a Coordinator turn that
 * started and completed after those facts. A worker receives only its own
 * queued/resumable task; this function records intent without executing it.
 */
export function planResumeActions(input: {
  projection: RunProjection;
  agentId: string;
  role: ScoutAgentRole;
}): ResumeAction[] {
  const actions: ResumeAction[] = input.projection.pendingMessages
    .filter((message) => message.agentId === input.agentId)
    .map((message) => ({
      type: ResumeActionTypes.ConsumeMessage,
      messageId: message.messageId,
    }));

  if (input.role === ScoutAgentRoles.Coordinator) {
    const completedCoordinatorTurns = input.projection.turns
      .filter((turn) =>
        turn.agentId === input.agentId
        && turn.role === ScoutAgentRoles.Coordinator
        && turn.status === "completed"
        && turn.completedAt !== undefined
      );

    for (const task of input.projection.tasks) {
      const checkpoint = inferTaskRecoveryCheckpoint(input.projection, task);
      if (checkpoint === TaskRecoveryCheckpoints.Interrupted) {
        actions.push({
          type: ResumeActionTypes.InspectInterruption,
          taskId: task.taskId,
        });
      } else if (checkpoint === TaskRecoveryCheckpoints.OutcomeSubmitted) {
        const taskFactSequences = [
          ...input.projection.taskOutcomes
            .filter((outcome) => outcome.taskId === task.taskId)
            .map((outcome) => outcome.journalSeq),
          ...input.projection.artifacts
            .filter((artifact) => artifact.taskId === task.taskId)
            .map((artifact) => artifact.journalSeq),
          ...input.projection.gates
            .filter((gate) => gate.taskId === task.taskId)
            .map((gate) => gate.journalSeq),
        ];
        const latestTaskFact = taskFactSequences
          .sort((left, right) => left - right)
          .at(-1);
        const hasCompletedCheckAfterFacts = latestTaskFact !== undefined
          && completedCoordinatorTurns.some((turn) =>
            turn.startedSeq > latestTaskFact
            && turn.completedSeq !== undefined
            && turn.completedSeq > latestTaskFact
          );
        const hasUnreviewedFacts = !hasCompletedCheckAfterFacts;
        if (!hasUnreviewedFacts) continue;
        actions.push({
          type: ResumeActionTypes.EvaluateOutcome,
          taskId: task.taskId,
        });
      } else if (checkpoint === TaskRecoveryCheckpoints.Terminated) {
        actions.push({
          type: ResumeActionTypes.ResolveTermination,
          taskId: task.taskId,
        });
      }
    }
    return actions;
  }

  const task = input.projection.tasks.find((candidate) =>
    candidate.agentId === input.agentId
  );
  const checkpoint = inferTaskRecoveryCheckpoint(input.projection, task);
  if (
    task
    && (
      checkpoint === TaskRecoveryCheckpoints.Queued
      || checkpoint === TaskRecoveryCheckpoints.Resumable
    )
  ) {
    actions.push({
      type: ResumeActionTypes.ResumeTask,
      taskId: task.taskId,
    });
  }
  return actions;
}
