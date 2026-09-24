import type {
  JarvisBehaviorWebSocketPlatformConnectResult,
  JarvisBehaviorWebSocketPlatformLink,
  JarvisBehaviorWebSocketPlatformLinkInput,
  JarvisBehaviorWebSocketPlatformPrepareResult,
} from "./jarvis-behavior-websocket-platform-link.js";

/** Keeps the iOS platform boundary explicit until its physical reverse path is implemented. */
export class JarvisBehaviorIosWebSocketLink implements JarvisBehaviorWebSocketPlatformLink {
  readonly identity;

  constructor(input: JarvisBehaviorWebSocketPlatformLinkInput) {
    this.identity = structuredClone(input.identity);
  }

  prepare(): Promise<JarvisBehaviorWebSocketPlatformPrepareResult> {
    return Promise.resolve(failure());
  }

  connect(): Promise<JarvisBehaviorWebSocketPlatformConnectResult> {
    return Promise.resolve(failure());
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function failure() {
  return {
    ok: false as const,
    code: "rbt_websocket_ios_link_unavailable",
    message: "The RBT WebSocket link for iOS is not implemented.",
    hostCommands: [],
  };
}
