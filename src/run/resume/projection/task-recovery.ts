import {
  AgentTaskStatuses,
  AgentTaskStepStatuses,
  type AgentTaskState,
} from "../../../agent/task/types.js";
import {
  ScoutAgentRoles,
  type ScoutAgentRole,
} from "../../../agent/thread/types.js";
import type { RunProjection } from "./run-projector.js";

export const TaskRecoveryCheckpoints = {
  Queued: "task_queued",
  Resumable: "task_resumable",
  WaitingForHumanInput: "waiting_for_human_input",
  Interrupted: "task_interrupted",
  OutcomeSubmitted: "outcome_submitted",
  Terminated: "task_terminated",
} as const;
export type TaskRecoveryCheckpoint =
  typeof TaskRecoveryCheckpoints[keyof typeof TaskRecoveryCheckpoints];

export const ResumeActionTypes = {
  ResumeTask: "resume_task",
  ConsumeMessage: "consume_message",
  InspectInterruption: "inspect_interruption",
  EvaluateOutcome: "evaluate_outcome",
  ResolveTermination: "resolve_termination",
} as const;
export type ResumeActionType =
  typeof ResumeActionTypes[keyof typeof ResumeActionTypes];

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
  if (
    task.steps?.at(-1)?.status === AgentTaskStepStatuses.Running
    || task.steps?.at(-1)?.status === AgentTaskStepStatuses.Interrupted
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
    for (const task of input.projection.tasks) {
      const checkpoint = inferTaskRecoveryCheckpoint(input.projection, task);
      if (checkpoint === TaskRecoveryCheckpoints.Interrupted) {
        actions.push({
          type: ResumeActionTypes.InspectInterruption,
          taskId: task.taskId,
        });
      } else if (checkpoint === TaskRecoveryCheckpoints.OutcomeSubmitted) {
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
