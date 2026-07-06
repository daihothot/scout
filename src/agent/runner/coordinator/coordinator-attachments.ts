import { attachments } from "../../context/attachments.js";
import type { AgentTaskOutcome } from "../../task/types.js";

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

export type CoordinatorObservationAttachmentInput =
  | {
    type: "dispatch";
    dispatchId: string;
    reason: string;
    message?: string;
    createdAt: string;
    data?: unknown;
  }
  | {
    type: "interrupt";
    eventKey: string;
    occurredAt?: string;
    interruptKind: string;
    taskId?: string;
    agentId?: string;
    turnId?: string;
    requestId?: string;
  }
  | {
    type: "task_assigned";
    agentId: string;
    taskId: string;
  }
  | AgentTaskOutcome;

export const coordinator = {
  user(input: CoordinatorUserAttachmentInput): string {
    return attachments.addTagBlock(CoordinatorContextTags.User, JSON.stringify(input, null, 2));
  },
  observation(input: CoordinatorObservationAttachmentInput): string {
    return attachments.addTagBlock(CoordinatorContextTags.Observation, JSON.stringify(input, null, 2));
  },
} as const;
