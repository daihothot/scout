import type { WorkflowData } from "./workflow-data.js";

/** A domain owner participates without exposing its stores, records, or projector. */
export interface ScoutWorkflowParticipant {
  create(): void | Promise<void>;
  restore(data: WorkflowData): void | Promise<void>;
  run(): void | Promise<void>;
  close(): void | Promise<void>;
  abort(): void | Promise<void>;
  clearWorkflow(): void | Promise<void>;
}
