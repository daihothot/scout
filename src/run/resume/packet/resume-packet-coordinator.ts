import { AgentStepStatuses } from "../../../agent/step/types.js";
import {
  inferTaskRecoveryCheckpoint,
  TaskRecoveryCheckpoints,
} from "../projection/task-recovery.js";
import { projectedStepsForTask } from "../projection/run-projector.js";
import {
  boundedText,
  renderArtifact,
  renderIdentity,
  renderRecoveryPrompt,
  renderResumeAction,
  type ResumePacket,
  type ResumePacketInput,
} from "./resume-packet-common.js";

/**
 * Builds the coordinator's recovery view from a read-only run projection.
 * It includes cross-agent task, gate, message, and interruption facts but does
 * not mutate the projection or perform any resume action.
 */
export function buildCoordinatorResumePacket(
  input: ResumePacketInput,
): ResumePacket {
  const openTasks = input.projection.tasks;
  const openTaskIds = new Set(openTasks.map((task) => task.taskId));
  const pendingMessages = input.projection.pendingMessages.filter((message) =>
    message.agentId === input.agentId
  );
  const pendingMessageIds = new Set(pendingMessages.map((message) => message.messageId));
  const allPendingMessageIds = new Set(
    input.projection.pendingMessages.map((message) => message.messageId),
  );

  const renderTasks = (): Array<Record<string, unknown>> => [
    ...openTasks.map((task) => ({
      id: task.taskId,
      agent_id: task.agentId,
      role: task.role,
      status: task.status,
      description: boundedText(task.description),
      recovery_checkpoint: inferTaskRecoveryCheckpoint(input.projection, task),
    })),
    ...input.projection.archivedTasks.slice(-20).map(({ task, archivedAt }) => ({
      id: task.taskId,
      agent_id: task.agentId,
      role: task.role,
      status: "archived",
      description: task.description,
      archived_at: archivedAt,
    })),
  ];

  const renderReported = (): Array<Record<string, unknown>> =>
    input.projection.taskOutcomes.slice(-12).map((outcome) => ({
      task_id: outcome.taskId,
      agent_id: outcome.agentId,
      step_id: outcome.stepId,
      submitted_at: outcome.submittedAt,
      outcome: boundedText(outcome.outcome),
    }));

  const renderConfirmed = (): Array<Record<string, unknown>> => [
    ...input.projection.userMessages
      .filter((message) => !pendingMessageIds.has(message.messageId))
      .slice(-3)
      .map((message) => ({
        type: "user_input",
        message_id: message.messageId,
        text: boundedText(message.text),
        accepted_at: message.acceptedAt,
      })),
    ...input.projection.humanInputRequests
      .filter((request) =>
        request.response
        && !allPendingMessageIds.has(request.response.message.messageId)
      )
      .slice(-20)
      .map((request) => ({
        type: "human_input_response",
        task_id: request.taskId,
        request_id: request.requestId,
        response: boundedText(request.response?.body),
        responded_at: request.response?.respondedAt,
      })),
    ...input.projection.gates.slice(-20)
      .filter((gate) => gate.status === "accepted")
      .map((gate) => ({
        type: "accepted_gate",
        gate_id: gate.gateId,
        checked_ref: gate.checkedRef,
        checked_digest: gate.checkedDigest,
        gate_ref: gate.gateRef,
        gate_digest: gate.gateDigest,
      })),
  ];

  const renderOpen = (): Array<Record<string, unknown>> => {
    const coordinatorStep = input.projection.steps
      .filter((step) =>
        step.agentId === input.agentId
        && step.taskId === undefined
        && (step.status === AgentStepStatuses.Running || step.status === AgentStepStatuses.Interrupted)
      )
      .at(-1);
    const coordinatorStepEntry = coordinatorStep
      ? [{
        type: coordinatorStep.status === AgentStepStatuses.Interrupted
          ? "interrupted_step"
          : "incomplete_step",
        step_id: coordinatorStep.stepId,
        started_at: coordinatorStep.startedAt,
        prompt: renderRecoveryPrompt(coordinatorStep.prompt),
      }]
      : [];
    const taskStepEntries = openTasks.flatMap((task) => {
      const step = projectedStepsForTask(input.projection, task).at(-1);
      if (
        step?.status !== AgentStepStatuses.Running
        && step?.status !== AgentStepStatuses.Interrupted
      ) return [];
      return [{
        type: step.status === AgentStepStatuses.Interrupted
          ? "interrupted_task_step"
          : "incomplete_task_step",
        task_id: task.taskId,
        step_id: step.stepId,
        started_at: step.startedAt,
      }];
    });
    const humanInputEntries = input.projection.humanInputRequests
      .filter((request) =>
        !request.response
        && openTaskIds.has(request.taskId)
        && inferTaskRecoveryCheckpoint(
          input.projection,
          openTasks.find((task) => task.taskId === request.taskId),
        ) === TaskRecoveryCheckpoints.WaitingForHumanInput
      )
      .map((request) => ({
        type: "human_input_request",
        task_id: request.taskId,
        request_id: request.requestId,
        body: pendingMessageIds.has(request.message.messageId)
          ? undefined
          : boundedText(request.body),
        requested_at: request.requestedAt,
      }));
    return [...coordinatorStepEntry, ...taskStepEntries, ...humanInputEntries];
  };

  const renderArtifacts = (): Array<Record<string, unknown>> => [
    ...input.projection.artifacts.slice(-20).map(renderArtifact),
    ...input.projection.gates.slice(-20).map((gate) => ({
      type: "gate",
      gate_id: gate.gateId,
      task_id: gate.taskId,
      checked_ref: gate.checkedRef,
      checked_digest: gate.checkedDigest,
      ref: gate.gateRef,
      digest: gate.gateDigest,
      status: gate.status,
    })),
  ];

  const renderPendingMessages = (): Array<Record<string, unknown>> =>
    pendingMessages.map((message) => ({
      message_id: message.messageId,
      queued_at: message.queuedAt,
    }));

  return {
    identity: renderIdentity(input),
    resume_actions: input.resumeActions.map(renderResumeAction),
    tasks: renderTasks(),
    reported: renderReported(),
    confirmed: renderConfirmed(),
    open: renderOpen(),
    artifacts: renderArtifacts(),
    pending_messages: renderPendingMessages(),
  };
}
