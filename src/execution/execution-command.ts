export interface ExecutionPlatformIdentity {
  type: string;
  version: string;
}

export interface ExecutionSelectionIdentity {
  transport: string;
  platform: ExecutionPlatformIdentity;
}

export interface ExecutionPlatformFailure {
  ok: false;
  code: string;
  message: string;
  requiresIdentify?: true;
}

export type ExecutionCommandResult =
  | { ok: true; selection: ExecutionSelectionIdentity }
  | ExecutionPlatformFailure;

/** One registered physical execution semantic. */
export interface ExecutionCommand {
  readonly operation: string;
  invoke(input: unknown): Promise<ExecutionCommandResult>;
}

export interface ExecutionPlatformRequest {
  transport?: string;
  platform?: string;
  identity?: ExecutionSelectionIdentity;
  appId?: string;
  parameters?: Readonly<Record<string, string>>;
}

export interface ExecutionOperationOptions {
  correlationId?: string;
}

export type ExecutionPlatformIdentifyResult =
  | { ok: true; identity: ExecutionPlatformIdentity }
  | ExecutionPlatformFailure;

export type ExecutionPlatformLaunchResult =
  | { ok: true; identity: ExecutionPlatformIdentity }
  | ExecutionPlatformFailure;

export type ExecutionPlatformShutdownResult =
  | { ok: true; identity: ExecutionPlatformIdentity }
  | ExecutionPlatformFailure;

export interface ExecutionPlatformPort {
  identify(
    request?: ExecutionPlatformRequest,
    options?: ExecutionOperationOptions,
  ): Promise<ExecutionPlatformIdentifyResult>;
  launch(
    request: ExecutionPlatformRequest,
    options?: ExecutionOperationOptions,
  ): Promise<ExecutionPlatformLaunchResult>;
  shutdown(
    request: ExecutionPlatformRequest,
    options?: ExecutionOperationOptions,
  ): Promise<ExecutionPlatformShutdownResult>;
}
