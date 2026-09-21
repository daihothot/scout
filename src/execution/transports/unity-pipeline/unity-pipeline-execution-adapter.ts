import type {
  ExecutionAdapter,
  ExecutionAdapterHandshakeResult,
} from "../../execution-adapter-registry.js";
import type {
  ExecutionPlatformIdentity,
  ExecutionPlatformOperationResult,
} from "../../execution-platform-port.js";
import { UnityPipelineEditorExecutor } from "./unity-pipeline-editor-executor.js";
import type { UnityPipelinePlatformExecutor } from "./unity-pipeline-platform-executor.js";

/** Identifies and dispatches execution-platform work backed by Unity Pipeline. */
export class UnityPipelineExecutionAdapter implements ExecutionAdapter {
  constructor(
    private readonly executors: readonly UnityPipelinePlatformExecutor[] = [
      new UnityPipelineEditorExecutor(),
    ],
  ) {}

  async handshake(): Promise<ExecutionAdapterHandshakeResult> {
    const identities: ExecutionPlatformIdentity[] = [];
    for (const executor of this.executors) {
      const result = await executor.identify();
      if (!result) continue;
      if (!result.ok) return { status: "failed", code: result.code, message: result.message };
      identities.push(result.identity);
    }
    if (identities.length === 0) {
      return { status: "unavailable" };
    }
    if (identities.length !== 1) {
      return {
        status: "failed",
        code: "execution_platform_ambiguous",
        message: "Exactly one execution platform is required.",
      };
    }
    return { status: "connected", identity: identities[0]! };
  }

  async launch(
    identity: ExecutionPlatformIdentity,
  ): Promise<ExecutionPlatformOperationResult> {
    const executor = this.executors.find((candidate) => candidate.platformType === identity.type);
    return executor
      ? executor.start(identity)
      : failure("execution_platform_unsupported", `Execution platform ${identity.type} is not supported.`);
  }

  async shutdown(
    identity: ExecutionPlatformIdentity,
  ): Promise<ExecutionPlatformOperationResult> {
    const executor = this.executors.find((candidate) => candidate.platformType === identity.type);
    return executor
      ? executor.stop(identity)
      : failure("execution_platform_unsupported", `Execution platform ${identity.type} is not supported.`);
  }
}

function failure(code: string, message: string): Extract<ExecutionPlatformOperationResult, { ok: false }> {
  return { ok: false, code, message };
}
