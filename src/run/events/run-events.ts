import {
  defineEventCatalog,
  event,
} from "../../core/events/index.js";

export interface RunCreatedEvent {
  runId: string;
  repoRoot: string;
  createdAt: string;
}

export interface RunRuntimeAttachedEvent {
  mode: "start" | "resume";
  attachedAt: string;
  processId: number;
}

export interface RunRuntimeReadyEvent {
  mode: "start" | "resume";
  readyAt: string;
}

export interface RunRuntimeDetachedEvent {
  reason: string;
  detachedAt: string;
}

export interface RunRuntimeInterruptedEvent {
  reason: string;
  interruptedAt: string;
}

export interface RunJournalWriteFailedEvent {
  failedEventId: string;
  failedEventKey: string;
  error: string;
  failedAt: string;
}

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
