import { defineEventCatalog, event } from "../../events/index.js";

export interface RequestSourceRegisteredEvent {
  readonly source: {
    readonly sourceId: string;
    readonly sourceKey: string;
    readonly type: string;
    readonly workflowId: string;
    readonly createdAt: string;
    readonly maxApprovals: number | null;
    readonly allowedGrants: readonly { readonly scope: object; readonly target: object }[];
    readonly state: { readonly status: "active" };
  };
}

export interface RequestSourceExpiredEvent {
  readonly sourceId: string;
  readonly workflowId: string;
  readonly reason: string;
}

/** Request lifecycle facts; approval and credential facts have their own catalogs. */
export const RequestSourceEvents = defineEventCatalog("system", {
  authorizationRequestSource: {
    registered: event<RequestSourceRegisteredEvent>(),
    expired: event<RequestSourceExpiredEvent>(),
  },
} as const);
