import {
  HostCommandExecutor,
  type HostCommandExecution,
} from "../../../../../host/host-command-executor.js";
import type { DynamicToolCallResponse } from "../../../../../agent-server/types.js";
import type { AgentJsonValue } from "../../../../../agent/tools/types.js";
import type { ScoutDomainDynamicToolCall } from "../../../../types.js";
import type { RbtAgentDynamicTool } from "../agent-tools.js";

export interface JarvisWebSocketSession {
  sessionId: string;
  endpoint: string;
  executable: string;
  baseArgs: string[];
  cwd: string;
}

export interface JarvisWebSocketConnectInput {
  agentId: string;
  sessionId: string;
  endpoint: string;
  executable: string;
  baseArgs: readonly string[];
  cwd: string;
  timeoutMs?: number;
}

export interface JarvisWebSocketConnectResult {
  status: "connected" | "reused" | "failed";
  session?: JarvisWebSocketSession;
  hostCommands: HostCommandExecution[];
  code?: string;
  error?: string;
}

interface SessionObservation {
  state: "connected" | "disconnected" | "unknown";
  endpoint?: string;
}

/** Implements the RBT Domain-internal Jarvis WebSocket dynamic-tool contract. */
export class JarvisWebSocketTool implements RbtAgentDynamicTool {
  private readonly sessions = new Map<string, JarvisWebSocketSession>();

  constructor(private readonly hostCommands = new HostCommandExecutor()) {}

  async execute(call: ScoutDomainDynamicToolCall): Promise<DynamicToolCallResponse> {
    try {
      const input = requireObject(call.input.arguments, "JarvisWebSocket arguments");
      const operation = input.operation;
      if (operation === "disconnect") {
        const sessionId = requiredString(input.session_id, "session_id");
        const session = this.sessions.get(sessionId);
        if (!session) return response(true, { status: "disconnected", sessionId });
        const command = await this.disconnect({
          sessionId: session.sessionId,
          executable: session.executable,
          baseArgs: session.baseArgs,
          cwd: session.cwd,
        });
        return response(command.result.status === "completed", {
          status: command.result.status === "completed" ? "disconnected" : "failed",
          sessionId,
          ...(command.result.error ? { error: command.result.error } : {}),
        });
      }
      if (operation !== "connect") {
        return response(false, {
          status: "failed",
          error: { code: "invalid_dynamic_tool_input", message: "operation must be connect or disconnect." },
        });
      }
      const sessionId = requiredString(input.session_id, "session_id");
      const endpoint = requiredString(input.endpoint, "endpoint");
      const result = await this.ensureSession({
        agentId: call.caller.agentId,
        sessionId,
        endpoint,
        executable: typeof input.executable === "string" ? input.executable : "jarvis",
        baseArgs: Array.isArray(input.base_args)
          ? input.base_args.filter((value): value is string => typeof value === "string")
          : [],
        cwd: typeof input.cwd === "string" ? input.cwd : process.cwd(),
      });
      return response(result.status !== "failed", {
        status: result.status,
        ...(result.session ? {
          sessionId: result.session.sessionId,
          endpoint: result.session.endpoint,
        } : {}),
        ...(result.code || result.error ? {
          error: { code: result.code ?? "websocket_failed", message: result.error ?? "WebSocket operation failed." },
        } : {}),
      });
    } catch (error) {
      return response(false, {
        status: "failed",
        error: {
          code: "invalid_dynamic_tool_input",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  session(sessionId: string): JarvisWebSocketSession | undefined {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : undefined;
  }

  async ensureSession(input: JarvisWebSocketConnectInput): Promise<JarvisWebSocketConnectResult> {
    if (input.sessionId.trim().length === 0 || input.endpoint.trim().length === 0) {
      return {
        status: "failed",
        hostCommands: [],
        code: "websocket_input_missing",
        error: "A non-empty WebSocket endpoint and session ID are required.",
      };
    }

    const existing = this.sessions.get(input.sessionId);
    if (existing && existing.endpoint !== input.endpoint) {
      return {
        status: "failed",
        hostCommands: [],
        code: "websocket_endpoint_conflict",
        error: `WebSocket session ${input.sessionId} is already assigned to ${existing.endpoint}.`,
      };
    }

    const hostCommands: HostCommandExecution[] = [];
    const statusBefore = await this.run(input, [
      ...input.baseArgs,
      "ws",
      "status",
      "--session",
      input.sessionId,
    ], input.timeoutMs ?? 5_000);
    hostCommands.push(statusBefore);
    const before = observeSessionStatus(statusBefore.result.stdout, statusBefore.result.stderr);
    if (before.state === "connected" && before.endpoint && before.endpoint !== input.endpoint) {
      return {
        status: "failed",
        hostCommands,
        code: "websocket_endpoint_conflict",
        error: `WebSocket session ${input.sessionId} is connected to ${before.endpoint}.`,
      };
    }
    if (before.state === "connected" && before.endpoint === input.endpoint) {
      const session = this.saveSession(input);
      return { status: "reused", session, hostCommands };
    }

    const connect = await this.run(input, [
      ...input.baseArgs,
      "ws",
      "connect",
      "--session",
      input.sessionId,
      "--url",
      input.endpoint,
      "--timeout-ms",
      String(Math.round((input.timeoutMs ?? 10_000))),
    ], (input.timeoutMs ?? 10_000) + 2_000);
    hostCommands.push(connect);
    if (connect.result.status !== "completed") {
      return {
        status: "failed",
        hostCommands,
        code: "websocket_connect_failed",
        error: "Jarvis could not connect the Behavioral WebSocket session.",
      };
    }

    const statusAfter = await this.run(input, [
      ...input.baseArgs,
      "ws",
      "status",
      "--session",
      input.sessionId,
    ], input.timeoutMs ?? 5_000);
    hostCommands.push(statusAfter);
    const after = observeSessionStatus(statusAfter.result.stdout, statusAfter.result.stderr);
    if (after.state !== "connected" || after.endpoint !== input.endpoint) {
      return {
        status: "failed",
        hostCommands,
        code: after.state === "connected"
          ? "websocket_endpoint_conflict"
          : "websocket_status_unconfirmed",
        error: after.state === "connected"
          ? `WebSocket session ${input.sessionId} connected to ${after.endpoint ?? "an unknown endpoint"}.`
          : "Jarvis did not confirm the requested WebSocket session endpoint after connecting.",
      };
    }
    const session = this.saveSession(input);
    return { status: "connected", session, hostCommands };
  }

  async disconnect(input: {
    sessionId: string;
    executable: string;
    baseArgs: readonly string[];
    cwd: string;
    timeoutMs?: number;
  }): Promise<HostCommandExecution> {
    this.sessions.delete(input.sessionId);
    return this.run(input, [
      ...input.baseArgs,
      "ws",
      "disconnect",
      "--session",
      input.sessionId,
    ], input.timeoutMs ?? 5_000);
  }

  async stop(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => this.run(session, [
      ...session.baseArgs,
      "ws",
      "disconnect",
      "--session",
      session.sessionId,
    ], 5_000)));
  }

  private saveSession(input: JarvisWebSocketConnectInput): JarvisWebSocketSession {
    const session: JarvisWebSocketSession = {
      sessionId: input.sessionId,
      endpoint: input.endpoint,
      executable: input.executable,
      baseArgs: [...input.baseArgs],
      cwd: input.cwd,
    };
    this.sessions.set(input.sessionId, session);
    return structuredClone(session);
  }

  private async run(
    input: {
      executable: string;
      cwd: string;
    },
    args: string[],
    timeoutMs: number,
  ): Promise<HostCommandExecution> {
    const startedAt = new Date().toISOString();
    const result = await this.hostCommands.run({
      executable: input.executable,
      args,
      cwd: input.cwd,
      env: process.env,
      timeoutMs,
    });
    return {
      executable: input.executable,
      args: [...args],
      cwd: input.cwd,
      startedAt,
      completedAt: new Date().toISOString(),
      result,
    };
  }
}

function observeSessionStatus(stdout: string, stderr: string): SessionObservation {
  const text = `${stdout}\n${stderr}`.trim();
  if (text.length === 0 || /not connected|disconnected|not found/i.test(text)) {
    return { state: "disconnected" };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (isRecord(value)) {
    const connected = value.connected ?? value.status;
    const endpoint = typeof value.url === "string"
      ? value.url
      : typeof value.endpoint === "string" ? value.endpoint : undefined;
    if (connected === true || connected === "connected") {
      return { state: "connected", ...(endpoint ? { endpoint } : {}) };
    }
    if (connected === false || connected === "disconnected") return { state: "disconnected" };
  }

  if (/connected/i.test(text)) {
    const endpoint = text.match(/(?:url|endpoint)\s*[=:]\s*(\S+)/i)?.[1]
      ?? text.match(/wss?:\/\/[^\s"']+/i)?.[0];
    return { state: "connected", ...(endpoint ? { endpoint } : {}) };
  }
  return { state: "unknown" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function response(success: boolean, output: AgentJsonValue): DynamicToolCallResponse {
  return {
    success,
    contentItems: [{ type: "inputText", text: JSON.stringify(output, null, 2) }],
  };
}
