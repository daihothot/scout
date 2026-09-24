import type { ExecutionPlatformFailure } from "./execution-command.js";
import type { ExecutionSelectionIdentity } from "./execution-command.js";

export type ExecutionHandlerValue =
  | null
  | boolean
  | number
  | string
  | ExecutionHandlerValue[]
  | { [key: string]: ExecutionHandlerValue };

export type ExecutionHandlerResult =
  | { ok: true; value?: ExecutionHandlerValue }
  | ExecutionPlatformFailure;

export interface ExecutionHandlerInvocation {
  operation: string;
  identity?: ExecutionSelectionIdentity;
  parameters: Readonly<Record<string, ExecutionHandlerValue>>;
}

/** Lifecycle and invocation boundary for one external physical execution service. */
export interface ExecutionHandler {
  start(): Promise<void>;
  invoke(invocation: ExecutionHandlerInvocation): Promise<ExecutionHandlerResult>;
  close(): Promise<void>;
}
