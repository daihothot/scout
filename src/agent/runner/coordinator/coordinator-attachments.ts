import { attachments } from "../../context/attachments.js";
import type { ScoutAgentRole } from "../../thread/types.js";

/** Tag names reserved for Coordinator context blocks. */
export const CoordinatorContextTags = {
  User: "coordinator-user",
  Observation: "coordinator-observation",
  WorkflowPhase: "workflow_phase",
} as const;

/** User message envelope inserted into the Coordinator prompt. */
export interface CoordinatorUserAttachmentInput {
  messageId: string;
  text: string;
  submittedAt: string;
  source?: string;
  data?: unknown;
}

/** Minimal observation emitted when a task is accepted. */
export interface CoordinatorTaskAssignedAttachmentInput {
  agentId: string;
  taskId: string;
}

/** Rejection observation preserved for Coordinator context and replay. */
export interface CoordinatorTaskNotAssignedAttachmentInput {
  agentId: string;
  role: ScoutAgentRole;
  activeTaskId: string;
  requestedDescription: string;
  reason: string;
}

/** Builds structured context blocks consumed by the Coordinator runner. */
export const coordinator = {
  workflowPhase(currentPhase: string): string {
    return attachments.addTagBlock(
      CoordinatorContextTags.WorkflowPhase,
      `current_phase: ${currentPhase}`,
    );
  },
  user(input: CoordinatorUserAttachmentInput): string {
    return attachments.addTagBlock(CoordinatorContextTags.User, JSON.stringify(input, null, 2));
  },
  taskAssigned(input: CoordinatorTaskAssignedAttachmentInput): string {
    return attachments.addTagBlock(CoordinatorContextTags.Observation, [
      "### Task Assigned",
      "",
      `- Agent ID: ${input.agentId}`,
      `- Task ID: ${input.taskId}`,
    ].join("\n"));
  },
  taskNotAssigned(input: CoordinatorTaskNotAssignedAttachmentInput): string {
    return attachments.addTagBlock(CoordinatorContextTags.Observation, [
      "### Task Not Assigned",
      "",
      `- Agent ID: ${input.agentId}`,
      `- Role: ${input.role}`,
      `- Active Task ID: ${input.activeTaskId}`,
      `- Requested Task: ${input.requestedDescription}`,
      `- Reason: ${input.reason}`,
    ].join("\n"));
  },
} as const;
