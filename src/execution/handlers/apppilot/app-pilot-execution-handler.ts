import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  ExecutionHandler,
  ExecutionHandlerInvocation,
  ExecutionHandlerResult,
  ExecutionHandlerValue,
} from "../../execution-handler.js";

type AppPilotResponse =
  | { id: string; ok: true; value?: ExecutionHandlerValue }
  | { id: string; ok: false; code: string; message: string; requiresIdentify?: true };

export interface AppPilotExecutionHandlerOptions {
  cwd: string;
  executable?: string;
  baseArgs?: readonly string[];
  commandTimeoutMs?: number;
}

/** Invokes the stateless AppPilot CLI once for each physical execution semantic. */
export class AppPilotExecutionHandler implements ExecutionHandler {
  constructor(private readonly options: AppPilotExecutionHandlerOptions) {}

  async start(): Promise<void> {}

  async invoke(invocation: ExecutionHandlerInvocation): Promise<ExecutionHandlerResult> {
    const args = appPilotArgs(invocation);
    if (!args.ok) return args;
    const id = randomUUID();
    try {
      const response = await invokeAppPilot(this.options, [...args.value, "--id", id]);
      if (response.id !== id) {
        return unavailable("AppPilot returned a response for a different invocation.");
      }
      if (response.ok) {
        return {
          ok: true,
          ...(response.value !== undefined ? { value: response.value } : {}),
        };
      }
      return {
        ok: false,
        code: response.code,
        message: response.message,
        ...(response.requiresIdentify ? { requiresIdentify: true } : {}),
      };
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error));
    }
  }

  async close(): Promise<void> {}
}

function invokeAppPilot(
  options: AppPilotExecutionHandlerOptions,
  args: readonly string[],
): Promise<AppPilotResponse> {
  const executable = options.executable ?? join(
    options.cwd,
    "assets",
    "scout",
    "plugins",
    "apppilot",
    ".codex",
    "runtime",
    "apppilot",
  );
  return new Promise<AppPilotResponse>((resolve, reject) => {
    execFile(
      executable,
      [...(options.baseArgs ?? []), ...args],
      {
        cwd: options.cwd,
        env: process.env,
        timeout: options.commandTimeoutMs ?? 90_000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || stdout.trim() || error.message));
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(stdout);
        } catch {
          reject(new Error("AppPilot returned a non-JSON response."));
          return;
        }
        const response = parseResponse(value);
        if (!response) {
          reject(new Error("AppPilot returned an invalid response."));
          return;
        }
        resolve(response);
      },
    );
  });
}

function parseResponse(value: unknown): AppPilotResponse | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.ok !== "boolean") {
    return undefined;
  }
  if (value.ok) {
    if (!("value" in value)) return { id: value.id, ok: true };
    return isHandlerValue(value.value)
      ? { id: value.id, ok: true, value: value.value }
      : undefined;
  }
  if (typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  if (value.requiresIdentify !== undefined && value.requiresIdentify !== true) return undefined;
  return {
    id: value.id,
    ok: false,
    code: value.code,
    message: value.message,
    ...(value.requiresIdentify ? { requiresIdentify: true } : {}),
  };
}

function isHandlerValue(value: unknown): value is ExecutionHandlerValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isHandlerValue);
  return isRecord(value) && Object.values(value).every(isHandlerValue);
}

function unavailable(message: string): ExecutionHandlerResult {
  return {
    ok: false,
    code: "apppilot_command_unavailable",
    message,
    requiresIdentify: true,
  };
}

function appPilotArgs(
  invocation: ExecutionHandlerInvocation,
): { ok: true; value: readonly string[] } | Extract<ExecutionHandlerResult, { ok: false }> {
  switch (invocation.operation) {
    case "identify": {
      const unexpected = Object.keys(invocation.parameters).filter((key) => key !== "transport");
      if (unexpected.length > 0 || invocation.identity) {
        return invalidInvocation(invocation.operation, invocation.identity ? ["identity"] : unexpected);
      }
      const transport = invocation.parameters.transport;
      if (transport !== undefined && typeof transport !== "string") {
        return invalidInvocation(invocation.operation, ["transport"]);
      }
      return {
        ok: true,
        value: transport ? ["identify", "--transport", transport] : ["identify"],
      };
    }
    case "launch":
    case "shutdown": {
      if (!invocation.identity) return invalidInvocation(invocation.operation, ["identity"]);
      const allowed = invocation.operation === "launch"
        ? new Set(["appId", "launchParameters"])
        : new Set(["appId"]);
      const unexpected = Object.keys(invocation.parameters).filter((key) => !allowed.has(key));
      if (unexpected.length > 0) return invalidInvocation(invocation.operation, unexpected);
      const appId = invocation.parameters.appId;
      if (appId !== undefined && typeof appId !== "string") {
        return invalidInvocation(invocation.operation, ["appId"]);
      }
      const launchParameters = invocation.parameters.launchParameters;
      if (launchParameters !== undefined && (
        invocation.operation !== "launch"
        || !isRecord(launchParameters)
        || Object.entries(launchParameters).some(([key, value]) => !key.trim() || typeof value !== "string")
      )) {
        return invalidInvocation(invocation.operation, ["launchParameters"]);
      }
      const parameterArgs = launchParameters && isRecord(launchParameters)
        ? Object.entries(launchParameters).flatMap(([key, value]) => ["--parameter", `${key}=${String(value)}`])
        : [];
      return {
        ok: true,
        value: [
          invocation.operation,
          "--identity",
          JSON.stringify(invocation.identity),
          ...(appId ? ["--app-id", appId] : []),
          ...parameterArgs,
        ],
      };
    }
    default:
      return {
        ok: false,
        code: "apppilot_operation_unsupported",
        message: `AppPilot does not implement execution operation ${invocation.operation}.`,
      };
  }
}

function invalidInvocation(
  operation: string,
  fields: readonly string[],
): Extract<ExecutionHandlerResult, { ok: false }> {
  return {
    ok: false,
    code: "apppilot_invalid_invocation",
    message: `AppPilot ${operation} received unsupported parameter(s): ${fields.join(", ")}.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
