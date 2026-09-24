import type { HostCommandExecution } from "../../../host/host-command-executor.js";
import type { ExecutionPlatformIdentity } from "../../../execution/index.js";
import { currentRunScope } from "../../../run/run-scope.js";
import type { ScoutDomainDynamicToolCall } from "../../types.js";
import { JarvisWebSocketTool } from "../agent/tools/jarvis-websocket/index.js";

const BEHAVIOR_TIMEOUT_MS = 10_000;

export interface JarvisBehaviorLinkContext {
  platform: ExecutionPlatformIdentity;
  sessionId: string;
  endpoint: string;
  freshSession: boolean;
  hostCommands: HostCommandExecution[];
}

export type JarvisBehaviorLinkResult =
  | { ok: true; context: JarvisBehaviorLinkContext }
  | {
    ok: false;
    code: string;
    message: string;
    hostCommands: HostCommandExecution[];
  };

export type JarvisBehaviorLinkPreparationResult =
  | {
    ok: true;
    launchParameters: Readonly<Record<string, string>>;
  }
  | Extract<JarvisBehaviorLinkResult, { ok: false }>;

/** Creates and restores the RBT connection after an execution target has been identified. */
export class JarvisBehaviorWebSocketLinker {
  private pendingHostCommands: HostCommandExecution[] = [];

  constructor(
    private readonly phase: "execute" | "review",
    private readonly executable: string,
    private readonly baseArgs: readonly string[],
    private readonly websocket: JarvisWebSocketTool,
  ) {}

  async prepare(
    identity: ExecutionPlatformIdentity,
    reset: boolean,
  ): Promise<JarvisBehaviorLinkPreparationResult> {
    const scope = currentRunScope();
    const prepared = await this.websocket.preparePlatformLink({
      identity,
      executable: this.executable,
      baseArgs: this.baseArgs,
      cwd: scope.scoutRoot,
    }, reset);
    this.pendingHostCommands.push(...prepared.hostCommands);
    return prepared.ok
      ? { ok: true, launchParameters: prepared.launchParameters }
      : {
        ok: false,
        code: prepared.code,
        message: prepared.message,
        hostCommands: this.takePendingHostCommands(),
      };
  }

  async connect(
    call: ScoutDomainDynamicToolCall,
    identity: ExecutionPlatformIdentity,
  ): Promise<JarvisBehaviorLinkResult> {
    const scope = currentRunScope();
    const platform = await this.websocket.connectPlatformLink(identity);
    this.pendingHostCommands.push(...platform.hostCommands);
    if (!platform.ok) {
      return {
        ok: false,
        code: platform.code,
        message: platform.message,
        hostCommands: this.takePendingHostCommands(),
      };
    }
    const sessionId = behaviorSessionId(scope.runId, call.caller.agentId, this.phase);
    const connection = await this.websocket.ensureSession({
      agentId: call.caller.agentId,
      sessionId,
      endpoint: platform.endpoint,
      executable: this.executable,
      baseArgs: this.baseArgs,
      cwd: scope.scoutRoot,
      timeoutMs: BEHAVIOR_TIMEOUT_MS,
    });
    this.pendingHostCommands.push(...connection.hostCommands);
    if (connection.status === "failed" || !connection.session) {
      return {
        ok: false,
        code: connection.code ?? "websocket_connect_failed",
        message: connection.error ?? "Jarvis could not establish the Behavioral session.",
        hostCommands: this.takePendingHostCommands(),
      };
    }
    return {
      ok: true,
      context: {
        platform: structuredClone(identity),
        sessionId,
        endpoint: platform.endpoint,
        freshSession: connection.status === "connected",
        hostCommands: this.takePendingHostCommands(),
      },
    };
  }

  async reconnect(
    call: ScoutDomainDynamicToolCall,
    current: JarvisBehaviorLinkContext,
  ): Promise<JarvisBehaviorLinkResult> {
    const scope = currentRunScope();
    const disconnect = await this.websocket.disconnect({
      sessionId: current.sessionId,
      executable: this.executable,
      baseArgs: this.baseArgs,
      cwd: scope.scoutRoot,
      timeoutMs: 5_000,
    });
    const connection = await this.websocket.ensureSession({
      agentId: call.caller.agentId,
      sessionId: current.sessionId,
      endpoint: current.endpoint,
      executable: this.executable,
      baseArgs: this.baseArgs,
      cwd: scope.scoutRoot,
      timeoutMs: BEHAVIOR_TIMEOUT_MS,
    });
    const hostCommands = [disconnect, ...connection.hostCommands];
    if (connection.status === "failed" || !connection.session) {
      return {
        ok: false,
        code: connection.code ?? "websocket_connect_failed",
        message: connection.error ?? "Jarvis could not restore the Behavioral session.",
        hostCommands,
      };
    }
    return {
      ok: true,
      context: {
        ...current,
        freshSession: true,
        hostCommands,
      },
    };
  }

  async abort(): Promise<void> {
    this.pendingHostCommands = [];
    await this.websocket.closePlatformLink();
  }

  private takePendingHostCommands(): HostCommandExecution[] {
    const commands = this.pendingHostCommands;
    this.pendingHostCommands = [];
    return commands;
  }
}

function behaviorSessionId(runId: string, agentId: string, phase: "execute" | "review"): string {
  return `scout-${runId}-${agentId}-${phase}`.replaceAll(/[^A-Za-z0-9._-]/g, "-");
}
