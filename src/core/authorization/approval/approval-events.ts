import { defineEventCatalog, event } from "../../events/index.js";
import type { ApprovalResult } from "./types.js";

export interface ApprovalSubmittedEvent {
  readonly approvalId: string;
  readonly sourceId: string;
  readonly sourceType: string;
  readonly workflowId: string;
  readonly submittedAt: string;
  readonly consumer: object;
  readonly result: ApprovalResult;
  readonly basis: { readonly kind: "new" } | { readonly kind: "denied" };
}

export const ApprovalEvents = defineEventCatalog("system", {
  authorizationApproval: {
    submitted: event<ApprovalSubmittedEvent>(),
  },
} as const);
