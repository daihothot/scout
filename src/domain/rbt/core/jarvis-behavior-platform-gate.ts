import type { DynamicToolCallResponse } from "../../../agent-server/types.js";
import { UnityPipelineTool } from "../../tools/index.js";
import type { ScoutDomainDynamicToolCall } from "../../types.js";
import type { RbtExecutionPlatform } from "../rbt-events.js";
import { JarvisBehaviorToolStore } from "./jarvis-behavior-tool-store.js";

export type PlatformRunResult =
  | { ok: true; platform: RbtExecutionPlatform }
  | { ok: false; code: string; message: string; response?: DynamicToolCallResponse };

/** Owns the RBT platform readiness and Play Mode gate. */
export class JarvisBehaviorPlatformGate {
  constructor(
    private readonly unityPipeline: UnityPipelineTool,
    private readonly store: JarvisBehaviorToolStore,
  ) {}

  async ensure(call: ScoutDomainDynamicToolCall): Promise<PlatformRunResult> {
    const invoke = async (operation: "status" | "editor_status" | "editor_play") => {
      const response = await this.unityPipeline.execute({
        ...call,
        input: {
          ...call.input,
          namespace: "rbt_unity_pipeline",
          tool: "UnityPipeline",
          arguments: { operation },
        },
      });
      const content = response.contentItems;
      if (content.length !== 1 || content[0]?.type !== "inputText") {
        return { response, output: undefined as Record<string, unknown> | undefined };
      }
      try {
        const output = JSON.parse(content[0].text) as unknown;
        return { response, output: isRecord(output) ? output : undefined };
      } catch {
        return { response, output: undefined as Record<string, unknown> | undefined };
      }
    };

    let platform = this.store.platform(call.caller.agentId);
    if (!platform) {
      const status = await invoke("status");
      const result = isRecord(status.output?.result) ? status.output.result : undefined;
      if (!status.response.success || status.output?.status !== "completed" || !result) {
        return failure("unity_editor_status_failed", "The connected Unity Editor status could not be read.");
      }
      if (result.count === 0) return failure("unity_editor_unavailable", "No connected Unity Editor is available.");
      if (result.count !== 1 || !Array.isArray(result.instances) || result.instances.length !== 1) {
        return failure("unity_editor_ambiguous", "Exactly one connected Unity Editor is required.");
      }
      const instance = result.instances[0];
      const version = isRecord(instance) ? instance.version : undefined;
      const state = isRecord(instance) ? instance.state : undefined;
      if (state !== "ready") return failure("unity_editor_unavailable", "The connected Unity Editor is not ready for RBT execution.");
      if (typeof version !== "string" || version.length === 0) {
        return failure("unity_editor_status_failed", "The connected Unity Editor did not report a version.");
      }
      platform = { type: "unity_editor", version };
    }

    const editorStatus = await invoke("editor_status");
    const editorState = isRecord(editorStatus.output?.result) ? editorStatus.output.result : undefined;
    if (!editorStatus.response.success
      || editorStatus.output?.status !== "completed"
      || !editorState
      || typeof editorState.status !== "string"
      || typeof editorState.compiling !== "boolean"
      || typeof editorState.domainReloadInProgress !== "boolean"
      || typeof editorState.playMode !== "string"
      || typeof editorState.unityVersion !== "string") {
      this.store.removePlatform(call.caller.agentId);
      return failure("unity_play_mode_status_failed", "The Unity Editor Play Mode status could not be read.");
    }
    if (editorState.status !== "ready" && editorState.status !== "playing") {
      this.store.removePlatform(call.caller.agentId);
      return failure("unity_editor_unavailable", "The connected Unity Editor is not ready for RBT execution.");
    }
    if (editorState.compiling) {
      this.store.removePlatform(call.caller.agentId);
      return failure("unity_editor_compiling", "The Unity Editor is compiling; RBT execution must stop until it is stable.");
    }
    if (editorState.domainReloadInProgress) {
      this.store.removePlatform(call.caller.agentId);
      return failure("unity_editor_domain_reload", "The Unity Editor domain reload is in progress; RBT execution must stop until it is stable.");
    }
    if (editorState.unityVersion !== platform.version) {
      this.store.removePlatform(call.caller.agentId);
      return failure("unity_editor_version_changed", "The connected Unity Editor version changed during the RBT execution.");
    }
    if (editorState.playMode !== "playing") {
      const editorPlay = await invoke("editor_play");
      if (!editorPlay.response.success
        || editorPlay.output?.status !== "completed") {
        this.store.removePlatform(call.caller.agentId);
        return failure("unity_play_mode_start_failed", "The Unity Editor did not enter Play Mode.");
      }

      const confirmedStatus = await invoke("editor_status");
      const confirmedState = isRecord(confirmedStatus.output?.result)
        ? confirmedStatus.output.result
        : undefined;
      if (!confirmedStatus.response.success
        || confirmedStatus.output?.status !== "completed"
        || !confirmedState
        || typeof confirmedState.status !== "string"
        || (confirmedState.status !== "ready" && confirmedState.status !== "playing")
        || typeof confirmedState.compiling !== "boolean"
        || typeof confirmedState.domainReloadInProgress !== "boolean"
        || typeof confirmedState.playMode !== "string"
        || typeof confirmedState.unityVersion !== "string"
        || confirmedState.compiling
        || confirmedState.domainReloadInProgress
        || confirmedState.playMode !== "playing") {
        this.store.removePlatform(call.caller.agentId);
        return failure("unity_play_mode_start_failed", "The Unity Editor did not enter Play Mode.");
      }
      if (confirmedState.unityVersion !== platform.version) {
        this.store.removePlatform(call.caller.agentId);
        return failure("unity_editor_version_changed", "The connected Unity Editor version changed while entering Play Mode.");
      }
    }
    this.store.setPlatform(call.caller.agentId, platform);
    return { ok: true, platform };
  }
}

function failure(code: string, message: string): PlatformRunResult {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
