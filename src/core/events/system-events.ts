import { defineEventCatalog, event } from "./event-catalog.js";

export const SystemEvents = defineEventCatalog("system", {
  task: {
    assigned: event(),
    messageQueued: event(),
    stopped: event(),
    outcomeRecorded: event(),
    humanInputRequested: event(),
    humanInputResponded: event(),
    threadAttached: event(),
    pendingMessagesDrained: event(),
    stepStarted: event(),
    stepCompleted: event(),
    stepOutput: event(),
    failed: event(),
    goalUpdated: event(),
    planUpdated: event(),
    terminal: event(),
  },
  interrupt: {
    raised: event(),
    resolved: event(),
    cancelled: event(),
    failed: event(),
  },
  orchestration: {
    coordinatorPromptReady: event(),
  },
});
