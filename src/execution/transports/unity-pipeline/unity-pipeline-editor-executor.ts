import {
  UnityPipelineTool,
  type UnityPipelineTransportResponse,
} from "./unity-pipeline-tool.js";
import type {
  ExecutionPlatformFailure,
  ExecutionPlatformIdentity,
  ExecutionPlatformIdentifyResult,
  ExecutionPlatformOperationResult,
} from "../../execution-platform-port.js";
import type { UnityPipelinePlatformExecutor } from "./unity-pipeline-platform-executor.js";

const UNITY_EDITOR_PLATFORM_TYPE = "unity_editor";

export interface UnityPipelineEditorExecutorOptions {
  readinessTimeoutMs?: number;
  pollIntervalMs?: number;
  commandTimeoutSeconds?: number;
}

interface UnityEditorState {
  status: string;
  compiling: boolean;
  domainReloadInProgress: boolean;
  playMode: string;
  unityVersion: string;
}

type UnityEditorStateResult =
  | { ok: true; state: UnityEditorState }
  | ExecutionPlatformFailure;

/** Executes the Unity Editor lifecycle through Unity Pipeline. */
export class UnityPipelineEditorExecutor implements UnityPipelinePlatformExecutor {
  readonly platformType = UNITY_EDITOR_PLATFORM_TYPE;
  private readonly readinessTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly commandTimeoutSeconds: number;

  constructor(
    private readonly unityPipeline = new UnityPipelineTool(),
    options: UnityPipelineEditorExecutorOptions = {},
  ) {
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.commandTimeoutSeconds = options.commandTimeoutSeconds ?? 5;
  }

  async identify(): Promise<ExecutionPlatformIdentifyResult | undefined> {
    const status = await this.invoke("status");
    const result = isRecord(status.result) ? status.result : undefined;
    if (!status.success || status.status !== "completed" || !result) {
      return failure("unity_editor_status_failed", "The connected Unity Editor status could not be read.");
    }
    if (result.count === 0) return undefined;
    if (result.count !== 1 || !Array.isArray(result.instances) || result.instances.length !== 1) {
      return failure("unity_editor_ambiguous", "Exactly one connected Unity Editor is required.");
    }
    const instance = result.instances[0];
    const version = isRecord(instance) ? instance.version : undefined;
    if (typeof version !== "string" || version.length === 0) {
      return failure("unity_editor_status_failed", "The connected Unity Editor did not report a version.");
    }
    return { ok: true, identity: { type: this.platformType, version } };
  }

  async start(
    identity: ExecutionPlatformIdentity,
  ): Promise<ExecutionPlatformOperationResult> {
    const current = await this.readEditorState();
    if (!current.ok) return current;
    const identityResult = this.requireIdentity(current.state, identity);
    if (!identityResult.ok) return identityResult;
    const availability = this.requireAvailableState(current.state);
    if (!availability.ok) return availability;
    if (current.state.compiling) {
      return failure("unity_editor_compiling", "The Unity Editor is compiling; execution must stop until it is stable.");
    }
    if (current.state.domainReloadInProgress) {
      return failure("unity_editor_domain_reload", "The Unity Editor domain reload is in progress; execution must stop until it is stable.");
    }
    if (current.state.playMode === "playing") return { ok: true };

    const play = await this.invoke("editor_play");
    if (!play.success || play.status !== "completed") {
      return failure("unity_play_mode_start_failed", "The Unity Editor did not accept the Play Mode start request.");
    }
    return this.waitForEditorPlayMode(identity, "playing");
  }

  async stop(
    identity: ExecutionPlatformIdentity,
  ): Promise<ExecutionPlatformOperationResult> {
    const current = await this.readEditorState();
    if (!current.ok) return current;
    const identityResult = this.requireIdentity(current.state, identity);
    if (!identityResult.ok) return identityResult;
    const availability = this.requireAvailableState(current.state);
    if (!availability.ok) return availability;
    if (current.state.compiling) {
      return failure("unity_editor_compiling", "The Unity Editor is compiling; execution must stop until it is stable.");
    }
    if (current.state.domainReloadInProgress) {
      return failure("unity_editor_domain_reload", "The Unity Editor domain reload is in progress; execution must stop until it is stable.");
    }
    if (current.state.playMode === "stopped") return { ok: true };

    const stop = await this.invoke("editor_stop");
    if (!stop.success || stop.status !== "completed") {
      return failure("unity_play_mode_stop_failed", "The Unity Editor did not accept the Play Mode stop request.");
    }
    return this.waitForEditorPlayMode(identity, "stopped");
  }

  private async waitForEditorPlayMode(
    identity: ExecutionPlatformIdentity,
    expected: "playing" | "stopped",
  ): Promise<ExecutionPlatformOperationResult> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    while (true) {
      const observed = await this.readEditorState();
      if (observed.ok) {
        const identityResult = this.requireIdentity(observed.state, identity);
        if (!identityResult.ok) return identityResult;
        if ((observed.state.status === "ready" || observed.state.status === "playing")
          && !observed.state.compiling
          && !observed.state.domainReloadInProgress
          && observed.state.playMode === expected) {
          return { ok: true };
        }
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return expected === "playing"
          ? failure("unity_play_mode_start_timeout", "The Unity Editor did not become ready in Play Mode before the platform timeout.")
          : failure("unity_play_mode_stop_timeout", "The Unity Editor did not leave Play Mode before the platform timeout.");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(this.pollIntervalMs, remainingMs)));
    }
  }

  private async readEditorState(): Promise<UnityEditorStateResult> {
    const status = await this.invoke("editor_status");
    const state = isRecord(status.result) ? status.result : undefined;
    if (!status.success
      || status.status !== "completed"
      || !state
      || typeof state.status !== "string"
      || typeof state.compiling !== "boolean"
      || typeof state.domainReloadInProgress !== "boolean"
      || typeof state.playMode !== "string"
      || typeof state.unityVersion !== "string") {
      return failure("unity_play_mode_status_failed", "The Unity Editor Play Mode status could not be read.");
    }
    return {
      ok: true,
      state: {
        status: state.status,
        compiling: state.compiling,
        domainReloadInProgress: state.domainReloadInProgress,
        playMode: state.playMode,
        unityVersion: state.unityVersion,
      },
    };
  }

  private requireIdentity(
    state: UnityEditorState,
    identity: ExecutionPlatformIdentity,
  ): ExecutionPlatformOperationResult {
    if (identity.type !== this.platformType || state.unityVersion !== identity.version) {
      return failure("execution_platform_changed", "The identified execution platform changed during its lifecycle operation.");
    }
    return { ok: true };
  }

  private requireAvailableState(state: UnityEditorState): ExecutionPlatformOperationResult {
    return state.status === "ready" || state.status === "playing"
      ? { ok: true }
      : failure("unity_editor_unavailable", "The connected Unity Editor is not ready for execution.");
  }

  private async invoke(
    operation: "status" | "editor_status" | "editor_play" | "editor_stop",
  ): Promise<UnityPipelineTransportResponse> {
    return this.unityPipeline.execute({
      operation,
      timeoutSeconds: this.commandTimeoutSeconds,
    });
  }
}

function failure(code: string, message: string): ExecutionPlatformFailure {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
