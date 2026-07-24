export type RunStageStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stopping"
  | "stopped";

export type RunLifecycleStatus =
  | "idle"
  | "starting"
  | "ready"
  | "terminating"
  | "terminated"
  | "failed";

export interface RunStage {
  readonly id: string;
  start(): Promise<void>;
  stop?(reason: string): Promise<void>;
}

export interface RunStageSnapshot {
  id: string;
  status: RunStageStatus;
  error?: string;
}

export interface RunLifecycleSnapshot {
  runId: string;
  status: RunLifecycleStatus;
  completedStages: number;
  totalStages: number;
  stages: RunStageSnapshot[];
  terminationReason?: string;
}
