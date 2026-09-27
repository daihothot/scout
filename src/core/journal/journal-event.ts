import type { EventKey, ScoutEvent } from "../events/index.js";

/** Versioned event record stored in an append-only Journal. */
export interface JournalEvent<TPayload = unknown>
  extends Omit<ScoutEvent<TPayload>, "key"> {
  key: EventKey;
  version: 1;
  seq: number;
  recordedAt: string;
}
