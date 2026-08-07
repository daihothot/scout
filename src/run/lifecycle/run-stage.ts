/** State of one registered stage during startup and shutdown. */
export type RunStageStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stopping"
  | "stopped";

/** State of the lifecycle executor as a whole. */
export type RunLifecycleStatus =
  | "idle"
  | "starting"
  | "ready"
  | "terminating"
  | "terminated"
  | "failed";

/** Minimal start/stop contract implemented by lifecycle stages. */
export interface RunStage {
  readonly id: string;
  start(): Promise<void>;
  stop?(reason: string): Promise<void>;
}

/** Published state for one stage, including a concise failure text. */
export interface RunStageSnapshot {
  id: string;
  status: RunStageStatus;
  error?: string;
}

/** Immutable projection used by interaction adapters to render lifecycle state. */
export interface RunLifecycleSnapshot {
  runId: string;
  status: RunLifecycleStatus;
  completedStages: number;
  totalStages: number;
  stages: RunStageSnapshot[];
  terminationReason?: string;
}
