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
  JarvisBehaviorToolStore,
} from "./jarvis-behavior-tool-store.js";
import type { JarvisBehaviorLinkContext } from "./jarvis-behavior-websocket-linker.js";
import type {
  RbtBehaviorRequest,
  RbtBehaviorResult,
} from "../rbt-events.js";

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
  retryableTransportFailure?: boolean;
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
  ) {}

  async run(
    call: ScoutDomainDynamicToolCall,
    command: string,
    payload: Record<string, AgentJsonValue>,
    link: JarvisBehaviorLinkContext,
  ): Promise<BehaviorCommandExecution> {
    const scope = currentRunScope();
    const request: RbtBehaviorRequest = {
      type: command,
      version: 1,
      correlationId: this.store.nextCorrelationId(scope.runId, call.caller.agentId, command),
      payload,
    };
    const startedAt = new Date().toISOString();
    const hostCommands: HostCommandExecution[] = [...link.hostCommands];
    const schema = await this.ensureSchema(link, hostCommands);
    if (!schema.ok) {
      return {
        request,
        status: "failed",
        errorCode: schema.code,
        error: schema.message,
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
        schema.path,
        "--session",
        link.sessionId,
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
      retryableTransportFailure: transportFailed
        && (isReadOnlyCommand(this.phase, command) || sessionWasDisconnected(callCommand)),
      hostCommands,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  private async ensureSchema(
    link: JarvisBehaviorLinkContext,
    hostCommands: HostCommandExecution[],
  ): Promise<{ ok: true; path: string } | { ok: false; code: string; message: string }> {
    const scope = currentRunScope();
    const environment = scope.environment.agents.executor;
    const schemaPath = environment?.mount.readableRoots
      .filter((root) => basename(root) === "gurusdk-unity")
      .map((root) => join(root, BEHAVIOR_SCHEMA_ROOT_RELATIVE_PATH))
      .find((candidate) => existsSync(candidate));
    if (!schemaPath) {
      return {
        ok: false,
        code: "behavior_schema_unavailable",
        message: "The Behavioral schema is unavailable under this run's Executor-bound gurusdk-unity codebase.",
      };
    }
    if (link.freshSession) this.store.clearSchemaConfiguration(link.sessionId);
    if (!this.store.schemaConfigured(link.sessionId)) {
      const configure = await this.runHostCommand({
        args: [
          ...this.baseArgs,
          "ws",
          "config.schema",
          "--session",
          link.sessionId,
          "--schema",
          schemaPath,
        ],
        timeoutMs: 5_000,
      });
      hostCommands.push(configure);
      if (configure.result.status !== "completed") {
        return {
          ok: false,
          code: "behavior_schema_config_failed",
          message: "Jarvis could not configure the Behavioral schema.",
        };
      }
      this.store.markSchemaConfigured(link.sessionId);
    }
    return { ok: true, path: schemaPath };
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
