import type { HostCommandExecution } from "../../../../../../host/host-command-executor.js";
import type { ExecutionPlatformIdentity } from "../../../../../../execution/index.js";

export interface JarvisBehaviorWebSocketPlatformLinkInput {
  identity: ExecutionPlatformIdentity;
  executable: string;
  baseArgs: readonly string[];
  cwd: string;
}

export type JarvisBehaviorWebSocketPlatformPrepareResult =
  | {
    ok: true;
    launchParameters: Readonly<Record<string, string>>;
    hostCommands: HostCommandExecution[];
  }
  | JarvisBehaviorWebSocketPlatformLinkFailure;

export type JarvisBehaviorWebSocketPlatformConnectResult =
  | {
    ok: true;
    endpoint: string;
    hostCommands: HostCommandExecution[];
  }
  | JarvisBehaviorWebSocketPlatformLinkFailure;

export interface JarvisBehaviorWebSocketPlatformLinkFailure {
  ok: false;
  code: string;
  message: string;
  hostCommands: HostCommandExecution[];
}

/** Platform-specific preparation and completion of one RBT WebSocket path. */
export interface JarvisBehaviorWebSocketPlatformLink {
  readonly identity: ExecutionPlatformIdentity;
  prepare(): Promise<JarvisBehaviorWebSocketPlatformPrepareResult>;
  connect(): Promise<JarvisBehaviorWebSocketPlatformConnectResult>;
  close(): Promise<void>;
}

export type JarvisBehaviorWebSocketPlatformLinkFactory = (
  input: JarvisBehaviorWebSocketPlatformLinkInput,
) => JarvisBehaviorWebSocketPlatformLink;
