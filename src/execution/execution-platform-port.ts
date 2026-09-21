/** Identity reported by the execution platform selected for the current run. */
export interface ExecutionPlatformIdentity {
  type: string;
  version: string;
}

export interface ExecutionPlatformFailure {
  ok: false;
  code: string;
  message: string;
}

export type ExecutionPlatformIdentifyResult =
  | { ok: true; identity: ExecutionPlatformIdentity }
  | ExecutionPlatformFailure;

export type ExecutionPlatformOperationResult =
  | { ok: true }
  | ExecutionPlatformFailure;

export type ExecutionPlatformLaunchResult =
  | { ok: true; identity: ExecutionPlatformIdentity }
  | ExecutionPlatformFailure;

export type ExecutionPlatformShutdownResult =
  | { ok: true; identity: ExecutionPlatformIdentity }
  | ExecutionPlatformFailure;

/** Launches and shuts down the execution session owned by the current Scout run. */
export interface ExecutionPlatformPort {
  launch(): Promise<ExecutionPlatformLaunchResult>;
  shutdown(): Promise<ExecutionPlatformShutdownResult>;
}
