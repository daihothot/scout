import type {
  EventKey,
  ScoutEvent,
} from "../../core/events/index.js";

export interface RunJournalEvent<TPayload = unknown>
  extends Omit<ScoutEvent<TPayload>, "key"> {
  key: EventKey;
  version: 1;
  seq: number;
  recordedAt: string;
}
