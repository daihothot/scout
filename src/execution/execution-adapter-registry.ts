import type {
  ExecutionPlatformFailure,
  ExecutionPlatformIdentity,
  ExecutionPlatformOperationResult,
} from "./execution-platform-port.js";

export type ExecutionAdapterHandshakeResult =
  | { status: "connected"; identity: ExecutionPlatformIdentity }
  | { status: "unavailable" }
  | { status: "failed"; code: string; message: string };

/** Internal transport adapter used by the execution system. */
export interface ExecutionAdapter {
  handshake(): Promise<ExecutionAdapterHandshakeResult>;
  launch(identity: ExecutionPlatformIdentity): Promise<ExecutionPlatformOperationResult>;
  shutdown(identity: ExecutionPlatformIdentity): Promise<ExecutionPlatformOperationResult>;
}

export type ExecutionAdapterSelectionResult =
  | {
    ok: true;
    adapter: ExecutionAdapter;
    identity: ExecutionPlatformIdentity;
  }
  | ExecutionPlatformFailure;

/** Selects the first connected adapter in deterministic registration order. */
export class ExecutionAdapterRegistry {
  constructor(private readonly adapters: readonly ExecutionAdapter[]) {}

  async handshake(): Promise<ExecutionAdapterSelectionResult> {
    let firstFailure: ExecutionPlatformFailure | undefined;
    for (const adapter of this.adapters) {
      const result = await adapter.handshake();
      if (result.status === "connected") {
        return {
          ok: true,
          adapter,
          identity: structuredClone(result.identity),
        };
      }
      if (result.status === "failed") {
        firstFailure ??= { ok: false, code: result.code, message: result.message };
      }
    }
    return firstFailure ?? {
      ok: false,
      code: "execution_platform_unavailable",
      message: "No execution platform is available.",
    };
  }
}
