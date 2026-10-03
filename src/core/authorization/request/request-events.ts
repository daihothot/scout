import { defineEventCatalog, event } from "../../events/index.js";

export interface RequestRegisteredEvent {
  readonly request: {
    readonly requestId: string;
    readonly type: string;
    readonly workflowId: string;
    readonly createdAt: string;
    readonly maxConsumptions: number;
    readonly allowedGrants: readonly { readonly scope: object; readonly target: object }[];
    readonly state: { readonly status: "active" };
  };
}

export interface RequestExpiredEvent {
  readonly requestId: string;
  readonly workflowId: string;
  readonly reason: string;
}

/** Request lifecycle facts; approval and credential facts have their own catalogs. */
export const RequestEvents = defineEventCatalog("system", {
  authorizationRequest: {
    registered: event<RequestRegisteredEvent>(),
    expired: event<RequestExpiredEvent>(),
  },
} as const);
