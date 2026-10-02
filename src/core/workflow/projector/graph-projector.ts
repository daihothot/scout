import {
  WorkflowEvents,
  type GraphData,
} from "../index.js";
import type { ScoutRecord } from "../../record/scout-record.js";

/** Restores the latest complete GraphData from the Run Journal. */
export function projectGraphData(events: readonly ScoutRecord[]): GraphData {
  let state: GraphData | undefined;
  for (const event of events) {
    if (WorkflowEvents.workflow.initialized.is(event)) {
      if (state) throw new Error("Run journal contains multiple Workflow initializations.");
      state = structuredClone(event.payload.state);
      continue;
    }
    if (WorkflowEvents.workflow.advanced.is(event)) {
      if (!state) {
        throw new Error("Workflow advanced before its graph was initialized.");
      }
      state = structuredClone(event.payload.state);
    }
  }
  if (!state) throw new Error("Run journal is missing system.workflow.initialized.");
  return state;
}
