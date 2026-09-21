import type {
  ExecutionPlatformIdentity,
  ExecutionPlatformIdentifyResult,
  ExecutionPlatformOperationResult,
} from "../../execution-platform-port.js";

/** Implements one platform lifecycle through Unity Pipeline. */
export interface UnityPipelinePlatformExecutor {
  readonly platformType: string;
  identify(): Promise<ExecutionPlatformIdentifyResult | undefined>;
  start(
    identity: ExecutionPlatformIdentity,
  ): Promise<ExecutionPlatformOperationResult>;
  stop(
    identity: ExecutionPlatformIdentity,
  ): Promise<ExecutionPlatformOperationResult>;
}
