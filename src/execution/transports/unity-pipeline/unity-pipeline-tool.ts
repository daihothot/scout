import { HostCommandExecutor } from "../../../host/host-command-executor.js";
import { currentRunScope } from "../../../run/run-scope.js";

type UnityPipelineJsonValue =
  | null
  | boolean
  | number
  | string
  | UnityPipelineJsonValue[]
  | { [key: string]: UnityPipelineJsonValue };

export type UnityPipelineOperation =
  | "version"
  | "status"
  | "list"
  | "editor_play"
  | "editor_status"
  | "editor_stop";

export interface UnityPipelineRequest {
  operation: UnityPipelineOperation;
  timeoutSeconds?: number;
}

export interface UnityPipelineTransportResponse {
  success: boolean;
  operation: UnityPipelineOperation;
  status: "completed" | "failed" | "timed_out";
  result?: UnityPipelineJsonValue;
  errors?: UnityPipelineJsonValue[];
  warnings?: UnityPipelineJsonValue[];
  error?: string;
}

interface ParsedUnityPipelineResult {
  success: boolean;
  result?: UnityPipelineJsonValue;
  errors?: UnityPipelineJsonValue[];
  warnings?: UnityPipelineJsonValue[];
  error?: string;
}

/** Sends one typed request through the host Unity Pipeline transport. */
export class UnityPipelineTool {
  private readonly hostCommands = new HostCommandExecutor();

  constructor(
    private readonly executable = "unity",
    private readonly baseArgs: readonly string[] = [],
  ) {}

  async execute(request: UnityPipelineRequest): Promise<UnityPipelineTransportResponse> {
    const operation = request.operation;
    try {
      const timeoutSeconds = positiveInteger(request.timeoutSeconds, 30, 120, "timeoutSeconds");

      const scope = currentRunScope();
      const operationArgs = operation === "version"
        ? ["--version"]
        : operation === "status" || operation === "list"
          ? ["--json", "--non-interactive", operation]
          : [
            "--json",
            "--non-interactive",
            "command",
            "--timeout",
            String(timeoutSeconds),
            operation,
          ];
      const result = await this.hostCommands.run({
        executable: this.executable,
        args: [...this.baseArgs, ...operationArgs],
        cwd: scope.scoutRoot,
        env: process.env,
        timeoutMs: (timeoutSeconds + 5) * 1_000,
      });
      if (result.status !== "completed") {
        return {
          success: false,
          operation,
          status: result.status,
          ...(result.error ? { error: result.error } : {}),
        };
      }
      const parsed = operation === "version"
        ? parseVersionResult(result.stdout)
        : parseJsonResult(operation, result.stdout);
      return {
        success: parsed.success,
        operation,
        status: parsed.success ? "completed" : "failed",
        ...(parsed.result !== undefined ? { result: parsed.result } : {}),
        ...(parsed.errors && parsed.errors.length > 0 ? { errors: parsed.errors } : {}),
        ...(parsed.warnings && parsed.warnings.length > 0 ? { warnings: parsed.warnings } : {}),
        ...(parsed.error ? { error: parsed.error } : {}),
      };
    } catch (error) {
      return {
        success: false,
        operation,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function parseVersionResult(stdout: string): ParsedUnityPipelineResult {
  const version = stdout.trim();
  if (version.length === 0) {
    return { success: false, error: "Unity Pipeline returned an empty version." };
  }
  return { success: true, result: { version } };
}

function parseJsonResult(operation: string, stdout: string): ParsedUnityPipelineResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    return {
      success: false,
      error: `Unity Pipeline result is not valid JSON: ${String(error)}`,
    };
  }
  const expectedCommand = operation.startsWith("editor_")
    ? `command ${operation}`
    : operation;
  if (!isRecord(value)
    || typeof value.success !== "boolean"
    || value.command !== expectedCommand
    || !("data" in value)
    || !Array.isArray(value.errors)
    || !Array.isArray(value.warnings)) {
    return {
      success: false,
      error: `Unity Pipeline result does not match operation ${operation}.`,
    };
  }
  const errors = value.errors.map(toJsonValue);
  const warnings = value.warnings.map(toJsonValue);
  const data = value.data;
  let parsedSuccess = value.success;
  let result: UnityPipelineJsonValue;
  if (!isRecord(data)) {
    return {
      success: false,
      errors,
      warnings,
      error: `Unity Pipeline ${operation} data must be an object.`,
    };
  }
  if (operation === "status") {
    if (typeof data.count !== "number"
      || !Number.isInteger(data.count)
      || !Array.isArray(data.instances)
      || data.count !== data.instances.length) {
      return {
        success: false,
        errors,
        warnings,
        error: "Unity Pipeline status data must contain count and instances.",
      };
    }
    const instances: UnityPipelineJsonValue[] = [];
    for (const instance of data.instances) {
      if (!isRecord(instance)
        || typeof instance.version !== "string"
        || typeof instance.state !== "string") {
        return {
          success: false,
          errors,
          warnings,
          error: "Unity Pipeline status instances must contain version and state.",
        };
      }
      instances.push({ version: instance.version, state: instance.state });
    }
    result = { count: data.count, instances };
  } else if (operation === "list") {
    if (typeof data.count !== "number"
      || !Number.isInteger(data.count)
      || !Array.isArray(data.tools)
      || data.count !== data.tools.length) {
      return {
        success: false,
        errors,
        warnings,
        error: "Unity Pipeline list data must contain count and tools.",
      };
    }
    const commands: UnityPipelineJsonValue[] = [];
    for (const tool of data.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string" || tool.name.length === 0) {
        return {
          success: false,
          errors,
          warnings,
          error: "Unity Pipeline list tools must contain non-empty names.",
        };
      }
      commands.push(tool.name);
    }
    result = { count: data.count, commands };
  } else {
    if (data.command !== operation || typeof data.success !== "boolean") {
      return {
        success: false,
        errors,
        warnings,
        error: `Unity Pipeline ${operation} data does not match the editor command result contract.`,
      };
    }
    parsedSuccess = value.success && data.success;

    if (operation !== "editor_status") {
      if (typeof data.result !== "string" || data.result.length === 0) {
        return {
          success: false,
          errors,
          warnings,
          error: `Unity Pipeline ${operation} result must be a non-empty message.`,
        };
      }
      return {
        success: parsedSuccess,
        result: data.result,
        errors,
        warnings,
        ...(!parsedSuccess
          ? { error: `Unity Pipeline operation ${operation} failed.` }
          : {}),
      };
    }

    if (!isRecord(data.result)) {
      return {
        success: false,
        errors,
        warnings,
        error: `Unity Pipeline ${operation} result does not contain the required Editor state.`,
      };
    }
    const editor = data.result;
    if (typeof editor.status !== "string"
      || typeof editor.compiling !== "boolean"
      || typeof editor.domainReloadInProgress !== "boolean"
      || typeof editor.playMode !== "string"
      || typeof editor.unityVersion !== "string") {
      return {
        success: false,
        errors,
        warnings,
        error: `Unity Pipeline ${operation} result does not contain the required Editor state.`,
      };
    }
    result = {
      status: editor.status,
      playMode: editor.playMode,
      compiling: editor.compiling,
      domainReloadInProgress: editor.domainReloadInProgress,
      unityVersion: editor.unityVersion,
    };
  }
  return {
    success: parsedSuccess,
    result,
    errors,
    warnings,
    ...(!parsedSuccess ? { error: `Unity Pipeline operation ${operation} failed.` } : {}),
  };
}

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function toJsonValue(value: unknown): UnityPipelineJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]),
    );
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
