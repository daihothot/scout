import { AgentStepStatuses } from "../../../agent/step/types.js";
import type { AgentMessage } from "../../../agent/message/types.js";
import type { ScoutAgentRole } from "../../../agent/thread/types.js";
import type { RunProjection } from "./run-projector.js";
import { inferTaskRecoveryCheckpoint, TaskRecoveryCheckpoints } from "./task-recovery.js";

/** Rebuilds delivery intent from accepted input facts without changing the projector. */
export function recoverPendingMessages(projection: RunProjection, synthesisRole: string): AgentMessage[] {
  const consumed = new Set(projection.consumedMessageIds);
  const delivered = new Set(projection.messageDeliveries.map((message) => message.messageId));
  const sequences = new Map(projection.messageSequences.map((fact) => [fact.messageId, fact.journalSeq]));
  return [
    ...projection.pendingMessages.map((message) => ({ seq: sequences.get(message.messageId)!, message })),
    ...projection.userMessages.filter((message) => !delivered.has(message.messageId) && !consumed.has(message.messageId))
      .map((message) => ({ seq: message.seq, message: { messageId: message.messageId, agentId: synthesisRole, body: message.attachment, queuedAt: message.acceptedAt } })),
  ].sort((left, right) => left.seq - right.seq).map(({ message }) => structuredClone(message));
}

/** Discriminants for actions a resumed agent may be asked to inspect or run. */
export const ResumeActionTypes = {
  ResumeTask: "resume_task",
  ResumeCoordinatorStep: "resume_coordinator_step",
  ContinuePhase: "continue_phase",
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
  | { type: typeof ResumeActionTypes.ContinuePhase; phase: string }
  | {
    type: typeof ResumeActionTypes.ResumeTask;
    taskId: string;
  }
  | {
    type: typeof ResumeActionTypes.ResumeCoordinatorStep;
    stepId: string;
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
 * Plans pending-message consumption and role-specific recovery actions. The
 * coordinator resumes its latest unfinished Step and evaluates a completed
 * task only when its outcome has not already been covered by a Coordinator
 * turn that started and completed after it in the Scout journal. Domain facts
 * have independent journal ordinals; Domain work arrives through Agent messages
 * and is recovered by the message-consumption path. A worker receives only its own
 * queued/resumable task; this function records intent without executing it.
 */
export function planResumeActions(input: {
  projection: RunProjection;
  agentId: string;
  role: ScoutAgentRole;
  synthesisRole: ScoutAgentRole;
}): ResumeAction[] {
  if (input.projection.workflowStatus !== "active") return [];
  const actions: ResumeAction[] = recoverPendingMessages(input.projection, input.synthesisRole)
    .filter((message) => message.agentId === input.agentId)
    .map((message) => ({
      type: ResumeActionTypes.ConsumeMessage,
      messageId: message.messageId,
    }));

  if (input.role === input.synthesisRole) {
    if (input.projection.pendingPhase !== undefined) {
      actions.push({ type: ResumeActionTypes.ContinuePhase, phase: input.projection.pendingPhase });
    }
    const coordinatorStep = input.projection.steps
      .filter((step) => step.agentId === input.agentId && step.taskId === undefined)
      .at(-1);
    if (
      coordinatorStep?.status === AgentStepStatuses.Running
      || coordinatorStep?.status === AgentStepStatuses.Interrupted
    ) {
      actions.push({
        type: ResumeActionTypes.ResumeCoordinatorStep,
        stepId: coordinatorStep.stepId,
      });
    }
    const completedCoordinatorTurns = input.projection.turns
      .filter((turn) =>
        turn.agentId === input.agentId
        && turn.role === input.synthesisRole
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
