import type {
  EventKey,
  ScoutEvent,
} from "../../core/events/index.js";

/** Versioned event record stored in a run's append-only JSONL journal. */
export interface RunJournalEvent<TPayload = unknown>
  extends Omit<ScoutEvent<TPayload>, "key"> {
  key: EventKey;
  version: 1;
  seq: number;
  recordedAt: string;
}
