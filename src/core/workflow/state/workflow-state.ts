/** Lifecycle of the Workflow service's current execution, not a persisted conclusion. */
export enum WorkflowState {
  Creating = "creating",
  Restoring = "restoring",
  Running = "running",
  Closing = "closing",
  Aborting = "aborting",
  Idle = "idle",
}
