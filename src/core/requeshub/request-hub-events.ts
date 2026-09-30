import { defineEventCatalog, event } from "../events/index.js";

/** Persisted registration data; contract validators and callbacks remain executable host code. */
export interface RequestRegisteredEvent {
  requestId: string;
  type: string;
  consumption: "single" | "multiple";
  payload: object;
}

export interface RequestCompletedEvent {
  requestId: string;
  result: object;
}

export interface RequestExpiredEvent {
  requestId: string;
  reason: string;
}

/** RequestHub-owned facts; no consumer, permission, or Workflow semantics. */
export const RequestHubEvents = defineEventCatalog("system", {
  requestHub: {
    registered: event<RequestRegisteredEvent>(),
    completed: event<RequestCompletedEvent>(),
    expired: event<RequestExpiredEvent>(),
  },
} as const);
