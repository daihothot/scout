import { attachments } from "../../context/attachments.js";
import type { ScoutAgentRole } from "../../thread/types.js";

export const CoordinatorContextTags = {
  User: "coordinator-user",
  Observation: "coordinator-observation",
} as const;

export interface CoordinatorUserAttachmentInput {
  messageId: string;
  text: string;
  submittedAt: string;
  source?: string;
  data?: unknown;
}

export interface CoordinatorTaskAssignedAttachmentInput {
  agentId: string;
  taskId: string;
}

export interface CoordinatorTaskNotAssignedAttachmentInput {
  agentId: string;
  role: ScoutAgentRole;
  activeTaskId: string;
  requestedDescription: string;
  reason: string;
}

export const coordinator = {
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
