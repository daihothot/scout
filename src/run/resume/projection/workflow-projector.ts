import {
  createGraphState,
  WorkflowEvents,
  type GraphState,
} from "../../../core/workflow/index.js";
import type { RunJournalEvent } from "../../journal/index.js";

/** Restores the latest complete GraphState from the Run Journal. */
export function projectGraphState(events: readonly RunJournalEvent[]): GraphState {
  let state: GraphState | undefined;
  for (const event of events) {
    if (WorkflowEvents.workflow.initialized.is(event)) {
      if (state) throw new Error("Run journal contains multiple Workflow initializations.");
      state = createGraphState(event.payload.state);
      continue;
    }
    if (WorkflowEvents.workflow.advanced.is(event)) {
      if (!state) {
        throw new Error("Workflow advanced before its graph was initialized.");
      }
      state = createGraphState(event.payload.state);
    }
  }
  if (!state) throw new Error("Run journal is missing system.workflow.initialized.");
  return state;
}
