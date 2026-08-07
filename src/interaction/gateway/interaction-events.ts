import { event } from "../../core/events/index.js";
import { SystemEvents } from "../../system/events/catalog.js";

const interactionEventCatalog = {
  interaction: {
    disclosureRequested: event(),
    userMessageSubmitted: event<UserMessageSubmittedPayload>(),
    exitRequested: event<InteractionExitRequestedPayload>(),
  },
} as const;

/** System-scoped interaction facts registered for the current runtime. */
SystemEvents.add(interactionEventCatalog);

/** Type-level view of the interaction event declarations added to SystemEvents. */
export type InteractionEventCatalog = typeof interactionEventCatalog;

/** User input envelope published after the gateway attaches its coordinator record. */
export interface UserMessageSubmittedPayload {
  messageId: string;
  text: string;
  submittedAt: string;
  attachment: string;
  source?: string;
  data?: unknown;
}

/** Fact emitted when the interaction surface asks the runtime to terminate. */
export interface InteractionExitRequestedPayload {
  requestedAt: string;
}
