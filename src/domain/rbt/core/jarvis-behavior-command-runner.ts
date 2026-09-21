import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentJsonValue } from "../../../agent/tools/types.js";
import {
  HostCommandExecutor,
  type HostCommandExecution,
} from "../../../host/host-command-executor.js";
import { currentRunScope } from "../../../run/run-scope.js";
import type { ScoutDomainDynamicToolCall } from "../../types.js";
import {
  JarvisWebSocketTool,
} from "../agent/tools/jarvis-websocket/index.js";
import {
  JarvisBehaviorToolStore,
} from "./jarvis-behavior-tool-store.js";
import type {
  RbtBehaviorRequest,
  RbtBehaviorResult,
} from "../rbt-events.js";

const BEHAVIOR_ENDPOINT = "ws://127.0.0.1:8083";
const BEHAVIOR_TIMEOUT_SECONDS = 10;
const BEHAVIOR_SCHEMA_ROOT_RELATIVE_PATH = join(
  "gurusdk-framework",
  "contracts",
  "schemas",
);
const EXECUTE_QUERY_COMMANDS = new Set([
  "behavior.registry.nodes",
  "behavior.registry.manifest",
  "behavior.node.variants",
  "behavior.evidence.sources",
  "behavior.trigger.commands",
]);
const REVIEW_QUERY_COMMANDS = new Set([
  "behavior.campaign.query",
  "behavior.evidence.query",
]);

export interface BehaviorCommandExecution {
  request: RbtBehaviorRequest;
  result?: RbtBehaviorResult;
  status: "completed" | "failed";
  errorCode?: string;
  error?: string;
  hostCommands: HostCommandExecution[];
  startedAt: string;
  completedAt: string;
}

/** Runs one Behavioral command after session and schema preparation. */
export class JarvisBehaviorCommandRunner {
  private readonly hostCommands = new HostCommandExecutor();

  constructor(
    private readonly phase: "execute" | "review",
    private readonly executable: string,
    private readonly baseArgs: readonly string[],
    private readonly store: JarvisBehaviorToolStore,
    private readonly websocket: JarvisWebSocketTool,
  ) {}

  async run(
    call: ScoutDomainDynamicToolCall,
    command: string,
    payload: Record<string, AgentJsonValue>,
  ): Promise<BehaviorCommandExecution> {
    const scope = currentRunScope();
    const request: RbtBehaviorRequest = {
      type: command,
      version: 1,
      correlationId: this.store.nextCorrelationId(scope.runId, call.caller.agentId, command),
      payload,
    };
    const startedAt = new Date().toISOString();
    const hostCommands: HostCommandExecution[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await this.ensureSession(call, hostCommands);
      if (session.error) {
        return {
          request,
          status: "failed",
          errorCode: session.code,
          error: session.error,
          hostCommands,
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }
      const callCommand = await this.runHostCommand({
        args: [
          ...this.baseArgs,
          "ws",
          "schema",
          "call",
          "behavior-control",
          "--schema",
          session.schemaPath,
          "--session",
          session.sessionId,
          "--params-json",
          JSON.stringify(request),
          "--timeout-ms",
          String(BEHAVIOR_TIMEOUT_SECONDS * 1_000),
        ],
        timeoutMs: (BEHAVIOR_TIMEOUT_SECONDS + 2) * 1_000,
      });
      hostCommands.push(callCommand);
      const parsed = parseBehaviorResult(callCommand.result.stdout, request.correlationId);
      const succeeded = callCommand.result.status === "completed"
        && parsed.error === undefined
        && parsed.result?.status === "ok"
        && parsed.result.code === "ok";
      if (succeeded) {
        return {
          request,
          result: parsed.result,
          status: "completed",
          hostCommands,
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }

      const transportFailed = callCommand.result.status !== "completed"
        || parsed.error !== undefined;
      const mayRetry = attempt === 0
        && transportFailed
        && (isReadOnlyCommand(this.phase, command) || sessionWasDisconnected(callCommand));
      if (transportFailed) await this.discardSession(session.sessionId, hostCommands);
      if (mayRetry) continue;

      const errorCode = callCommand.result.status !== "completed"
        ? "host_command_failed"
        : parsed.error
          ? "invalid_behavior_result"
          : parsed.result?.code;
      const error = callCommand.result.status !== "completed"
        ? callCommand.result.error ?? `Jarvis command ${callCommand.result.status}.`
        : parsed.error ?? behaviorErrorMessage(parsed.result);
      return {
        request,
        ...(parsed.result ? { result: parsed.result } : {}),
        status: "failed",
        ...(errorCode ? { errorCode } : {}),
        ...(error ? { error } : {}),
        hostCommands,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
    throw new Error("JarvisBehavior command retry loop ended without a result.");
  }

  private async ensureSession(
    call: ScoutDomainDynamicToolCall,
    hostCommands: HostCommandExecution[],
  ): Promise<{ sessionId: string; schemaPath: string; code?: string; error?: string }> {
    const scope = currentRunScope();
    // The host uses the run's execution target; Reviewer does not need source access.
    const environment = scope.environment.agents.executor;
    const schemaPath = environment?.mount.readableRoots
      .filter((root) => basename(root) === "gurusdk-unity")
      .map((root) => join(root, BEHAVIOR_SCHEMA_ROOT_RELATIVE_PATH))
      .find((candidate) => existsSync(candidate));
    if (!schemaPath) {
      return {
        sessionId: "",
        schemaPath: "",
        code: "behavior_schema_unavailable",
        error: "The Behavioral schema is unavailable under this run's Executor-bound gurusdk-unity codebase.",
      };
    }
    const sessionId = behaviorSessionId(scope.runId, call.caller.agentId, this.phase);
    const connection = await this.websocket.ensureSession({
      agentId: call.caller.agentId,
      sessionId,
      endpoint: BEHAVIOR_ENDPOINT,
      executable: this.executable,
      baseArgs: this.baseArgs,
      cwd: scope.scoutRoot,
      timeoutMs: BEHAVIOR_TIMEOUT_SECONDS * 1_000,
    });
    hostCommands.push(...connection.hostCommands);
    if (connection.status === "failed" || !connection.session) {
      return {
        sessionId,
        schemaPath,
        code: connection.code ?? "websocket_connect_failed",
        error: connection.error ?? "Jarvis could not establish the Behavioral session.",
      };
    }

    if (!this.store.schemaConfigured(sessionId)) {
      const configure = await this.runHostCommand({
        args: [
          ...this.baseArgs,
          "ws",
          "config.schema",
          "--session",
          sessionId,
          "--schema",
          schemaPath,
        ],
        timeoutMs: 5_000,
      });
      hostCommands.push(configure);
      if (configure.result.status !== "completed") {
        await this.discardSession(sessionId, hostCommands);
        return {
          sessionId,
          schemaPath,
          code: "behavior_schema_config_failed",
          error: "Jarvis could not configure the Behavioral schema.",
        };
      }
      this.store.markSchemaConfigured(sessionId);
    }
    return { sessionId, schemaPath };
  }

  private async discardSession(
    sessionId: string,
    hostCommands: HostCommandExecution[],
  ): Promise<void> {
    this.store.clearSchemaConfiguration(sessionId);
    const scope = currentRunScope();
    const disconnect = await this.websocket.disconnect({
      sessionId,
      executable: this.executable,
      baseArgs: this.baseArgs,
      cwd: scope.scoutRoot,
      timeoutMs: 5_000,
    });
    hostCommands.push(disconnect);
  }

  private async runHostCommand(input: {
    args: string[];
    timeoutMs: number;
  }): Promise<HostCommandExecution> {
    const scope = currentRunScope();
    const startedAt = new Date().toISOString();
    const result = await this.hostCommands.run({
      executable: this.executable,
      args: input.args,
      cwd: scope.scoutRoot,
      env: process.env,
      timeoutMs: input.timeoutMs,
    });
    return {
      executable: this.executable,
      args: [...input.args],
      cwd: scope.scoutRoot,
      startedAt,
      completedAt: new Date().toISOString(),
      result,
    };
  }
}

function parseBehaviorResult(
  stdout: string,
  expectedCorrelationId: string,
): { result?: RbtBehaviorResult; error?: string } {
  const resultLines = stdout.split(/\r?\n/).filter((line) => line.startsWith("[RESULT] "));
  if (resultLines.length !== 1) {
    return { error: `Jarvis returned ${resultLines.length} Behavioral result envelopes.` };
  }
  let value: unknown;
  try {
    value = JSON.parse(resultLines[0]?.slice("[RESULT] ".length) ?? "");
  } catch (error) {
    return { error: `Jarvis Behavioral result is not valid JSON: ${String(error)}` };
  }
  if (!isRecord(value)
    || value.type !== "behavior.command.result"
    || value.version !== 1
    || typeof value.correlationId !== "string"
    || typeof value.status !== "string"
    || typeof value.code !== "string"
    || !("payload" in value)) {
    return { error: "Jarvis Behavioral result envelope does not match the request." };
  }
  const result: RbtBehaviorResult = {
    type: value.type,
    version: value.version,
    correlationId: value.correlationId,
    status: value.status,
    code: value.code,
    payload: toJsonValue(value.payload),
  };
  if (value.correlationId !== expectedCorrelationId) {
    return {
      result,
      error: "Jarvis Behavioral result correlationId does not match the request.",
    };
  }
  return { result };
}

function behaviorErrorMessage(result: RbtBehaviorResult | undefined): string {
  if (isRecord(result?.payload) && typeof result.payload.message === "string") {
    return result.payload.message;
  }
  return `Behavioral command returned ${result?.status ?? "an invalid result"}.`;
}

function isReadOnlyCommand(phase: "execute" | "review", command: string): boolean {
  return (phase === "execute" ? EXECUTE_QUERY_COMMANDS : REVIEW_QUERY_COMMANDS).has(command);
}

function sessionWasDisconnected(command: HostCommandExecution): boolean {
  return `${command.result.stdout}\n${command.result.stderr}`
    .includes("is not connected. Run jarvis ws connect first.");
}

function behaviorSessionId(runId: string, agentId: string, phase: "execute" | "review"): string {
  return `scout-${runId}-${agentId}-${phase}`.replaceAll(/[^A-Za-z0-9._-]/g, "-");
}

function toJsonValue(value: unknown): AgentJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]));
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
