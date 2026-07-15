export type BootStageStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stopping"
  | "stopped";

export type BootStatus =
  | "idle"
  | "starting"
  | "ready"
  | "terminating"
  | "terminated"
  | "failed";

export interface BootStage {
  readonly id: string;
  start(): Promise<void>;
  stop?(reason: string): Promise<void>;
}

export interface BootStageSnapshot {
  id: string;
  status: BootStageStatus;
  error?: string;
}

export interface BootSnapshot {
  runId: string;
  status: BootStatus;
  completedStages: number;
  totalStages: number;
  stages: BootStageSnapshot[];
  terminationReason?: string;
}
