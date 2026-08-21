import {
  AgentTaskStatuses,
} from "../../../agent/task/types.js";
import { AgentStepStatuses } from "../../../agent/step/types.js";
import { inferTaskRecoveryCheckpoint } from "../projection/task-recovery.js";
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
 * Builds the selected worker's focused recovery view. A missing task is kept
 * representable so the caller can still inject identity and pending delivery
 * facts without fabricating a new task or changing journal state.
 */
export function buildWorkerResumePacket(
  input: ResumePacketInput,
): ResumePacket {
  const task = input.projection.tasks.find((candidate) => candidate.agentId === input.agentId);
  const pendingMessages = input.projection.pendingMessages.filter((message) =>
    message.agentId === input.agentId
  );
  const allPendingMessageIds = new Set(
    input.projection.pendingMessages.map((message) => message.messageId),
  );
  const checkpoint = inferTaskRecoveryCheckpoint(input.projection, task);
  const requests = task
    ? input.projection.humanInputRequests.filter((request) => request.taskId === task.taskId)
    : [];
  const taskSteps = task ? projectedStepsForTask(input.projection, task) : [];
  const currentStep = taskSteps.at(-1);

  const renderTask = (): Record<string, unknown> | undefined => {
    if (!task) return undefined;
    return {
      id: task.taskId,
      status: task.status,
      description: boundedText(task.description),
      initial_prompt: boundedText(task.initialPrompt),
      current_step: currentStep
        ? {
          id: currentStep.stepId,
          status: currentStep.status,
          final_response: boundedText(currentStep.finalResponse),
        }
        : undefined,
    };
  };

  const renderReported = (): Array<Record<string, unknown>> =>
    input.projection.taskOutcomes
      .filter((outcome) => outcome.agentId === input.agentId)
      .slice(-2)
      .map((outcome) => ({
        task_id: outcome.taskId,
        step_id: outcome.stepId,
        submitted_at: outcome.submittedAt,
        outcome: boundedText(outcome.outcome),
      }));

  const renderConfirmed = (): Array<Record<string, unknown>> =>
    requests
      .filter((request) =>
        request.response
        && !allPendingMessageIds.has(request.response.message.messageId)
      )
      .map((request) => ({
        request_id: request.requestId,
        response: boundedText(request.response?.body),
        responded_at: request.response?.respondedAt,
      }));

  const renderOpen = (): Array<Record<string, unknown>> => [
    ...(currentStep?.status === AgentStepStatuses.Running
      || currentStep?.status === AgentStepStatuses.Interrupted
      ? [{
        type: currentStep.status === AgentStepStatuses.Interrupted
          ? "interrupted_task_step"
          : "incomplete_task_step",
        step_id: currentStep.stepId,
        started_at: currentStep.startedAt,
        prompt: renderRecoveryPrompt(currentStep.prompt),
      }]
      : []),
    ...requests.filter((request) =>
      !request.response
      && task?.status !== AgentTaskStatuses.Done
      && task?.status !== AgentTaskStatuses.Failed
      && task?.status !== AgentTaskStatuses.Stopped
    ).map((request) => ({
      type: "human_input_request",
      request_id: request.requestId,
      body: boundedText(request.body),
      requested_at: request.requestedAt,
    })),
  ];

  const renderArtifacts = (): Array<Record<string, unknown>> =>
    input.projection.artifacts
      .filter((artifact) => artifact.agentId === input.agentId || artifact.taskId === task?.taskId)
      .slice(-20)
      .map(renderArtifact);

  const renderPendingMessages = (): Array<Record<string, unknown>> =>
    pendingMessages.map((message) => ({
      message_id: message.messageId,
      task_id: message.taskId,
      queued_at: message.queuedAt,
    }));

  return {
    identity: renderIdentity(input),
    task_recovery_checkpoint: checkpoint,
    resume_actions: input.resumeActions.map(renderResumeAction),
    task: renderTask(),
    reported: renderReported(),
    confirmed: renderConfirmed(),
    open: renderOpen(),
    artifacts: renderArtifacts(),
    pending_messages: renderPendingMessages(),
  };
}
