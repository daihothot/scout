import { event } from "../../core/events/index.js";
import { SystemEvents } from "../../system/events/catalog.js";
import type {
  HumanInputResponse,
  RuntimeDisclosureEvent,
  RuntimeProgressEvent,
} from "../port.js";

const interactionEventCatalog = {
  interaction: {
    disclosureRequested: event(),
    progressRequested: event(),
    userMessageSubmitted: event(),
    humanInputReceived: event(),
  },
} as const;

SystemEvents.add(interactionEventCatalog);

export type InteractionEventCatalog = typeof interactionEventCatalog;

export type InteractionDisclosureRequestedPayload = RuntimeDisclosureEvent;

export type InteractionProgressRequestedPayload = RuntimeProgressEvent;

export interface UserMessageSubmittedPayload {
  messageId: string;
  text: string;
  submittedAt: string;
  source?: string;
  data?: unknown;
}

export interface InteractionHumanInputReceivedPayload {
  taskId: string;
  agentId: string;
  requestId: string;
  response: HumanInputResponse;
}
