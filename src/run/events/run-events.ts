import {
  defineEventCatalog,
  event,
} from "../../core/events/index.js";

/** Fact emitted when a run directory and initial identity are created. */
export interface RunCreatedEvent {
  runId: string;
  repoRoot: string;
  createdAt: string;
}

/** Fact emitted when a start or resume process attaches to a run. */
export interface RunRuntimeAttachedEvent {
  mode: "start" | "resume";
  attachedAt: string;
  processId: number;
}

/** Fact emitted after runtime startup reaches its ready state. */
export interface RunRuntimeReadyEvent {
  mode: "start" | "resume";
  readyAt: string;
}

/** Fact emitted when a runtime detaches after an ordinary termination path. */
export interface RunRuntimeDetachedEvent {
  reason: string;
  detachedAt: string;
}

/** Fact emitted when startup is interrupted before normal detachment. */
export interface RunRuntimeInterruptedEvent {
  reason: string;
  interruptedAt: string;
}

/** Fact emitted when the journal cannot persist an event after retrying. */
export interface RunJournalWriteFailedEvent {
  failedEventId: string;
  failedEventKey: string;
  error: string;
  failedAt: string;
}

/** Event catalog shared by run stages, journal persistence, and observers. */
export const RunEvents = defineEventCatalog("system", {
  run: {
    created: event<RunCreatedEvent>(),
  },
  journal: {
    writeFailed: event<RunJournalWriteFailedEvent>(),
  },
  runtime: {
    attached: event<RunRuntimeAttachedEvent>(),
    ready: event<RunRuntimeReadyEvent>(),
    detached: event<RunRuntimeDetachedEvent>(),
    interrupted: event<RunRuntimeInterruptedEvent>(),
  },
} as const);
