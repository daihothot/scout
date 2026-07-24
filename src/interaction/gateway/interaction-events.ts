import { event } from "../../core/events/index.js";
import { SystemEvents } from "../../system/events/catalog.js";

const interactionEventCatalog = {
  interaction: {
    disclosureRequested: event(),
    userMessageSubmitted: event<UserMessageSubmittedPayload>(),
    exitRequested: event<InteractionExitRequestedPayload>(),
  },
} as const;

SystemEvents.add(interactionEventCatalog);

export type InteractionEventCatalog = typeof interactionEventCatalog;

export interface UserMessageSubmittedPayload {
  messageId: string;
  text: string;
  submittedAt: string;
  attachment: string;
  source?: string;
  data?: unknown;
}

export interface InteractionExitRequestedPayload {
  requestedAt: string;
}
