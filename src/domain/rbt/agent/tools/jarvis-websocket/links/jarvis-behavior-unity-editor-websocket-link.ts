import type {
  JarvisBehaviorWebSocketPlatformConnectResult,
  JarvisBehaviorWebSocketPlatformLink,
  JarvisBehaviorWebSocketPlatformLinkInput,
  JarvisBehaviorWebSocketPlatformPrepareResult,
} from "./jarvis-behavior-websocket-platform-link.js";

const LOCAL_BEHAVIOR_ENDPOINT = "ws://127.0.0.1:8083";

/** Uses the Unity Editor's direct local WebSocket server. */
export class JarvisBehaviorUnityEditorWebSocketLink implements JarvisBehaviorWebSocketPlatformLink {
  readonly identity;

  constructor(input: JarvisBehaviorWebSocketPlatformLinkInput) {
    this.identity = structuredClone(input.identity);
  }

  prepare(): Promise<JarvisBehaviorWebSocketPlatformPrepareResult> {
    return Promise.resolve({ ok: true, launchParameters: {}, hostCommands: [] });
  }

  connect(): Promise<JarvisBehaviorWebSocketPlatformConnectResult> {
    return Promise.resolve({ ok: true, endpoint: LOCAL_BEHAVIOR_ENDPOINT, hostCommands: [] });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
