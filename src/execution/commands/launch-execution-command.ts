import type {
  ExecutionCommand,
  ExecutionCommandResult,
  ExecutionSelectionIdentity,
} from "../execution-command.js";
import type { ExecutionHandler } from "../execution-handler.js";

/** Launches the application represented by the caller-owned execution identity. */
export class LaunchExecutionCommand implements ExecutionCommand {
  readonly operation = "launch";

  constructor(private readonly handler: ExecutionHandler) {}

  async invoke(input: unknown): Promise<ExecutionCommandResult> {
    if (!isRecord(input)) return invalidInput("Launch parameters must be an object.");
    const unexpected = Object.keys(input).filter(
      (key) => key !== "identity" && key !== "appId" && key !== "parameters",
    );
    if (unexpected.length > 0) {
      return invalidInput(`Launch received unsupported parameter(s): ${unexpected.join(", ")}.`);
    }
    const appId = optionalString(input.appId, "appId");
    if (!appId.ok) return appId;
    let parameters: Record<string, string> | undefined;
    if (input.parameters !== undefined) {
      if (!isRecord(input.parameters)) {
        return invalidInput("parameters must be a string dictionary when provided.");
      }
      parameters = {};
      for (const [key, value] of Object.entries(input.parameters)) {
        if (!key.trim()) return invalidInput("parameters cannot contain an empty key.");
        if (typeof value !== "string") {
          return invalidInput(`parameters.${key} must be a string.`);
        }
        parameters[key] = value;
      }
    }
    const selection = executionIdentity(input.identity);
    if (!selection.ok) return selection;
    if (selection.value.platform.type === "android" && !appId.value) {
      return invalidInput("Android launch requires appId.");
    }

    const result = await this.handler.invoke({
      operation: this.operation,
      identity: selection.value,
      parameters: {
        ...(appId.value ? { appId: appId.value } : {}),
        ...(parameters ? { launchParameters: parameters } : {}),
      },
    });
    return result.ok ? { ok: true, selection: selection.value } : result;
  }
}

function optionalString(
  value: unknown,
  name: string,
): { ok: true; value?: string } | Extract<ExecutionCommandResult, { ok: false }> {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidInput(`${name} must be a non-empty string when provided.`);
  }
  return { ok: true, value: value.trim() };
}

function invalidInput(message: string): Extract<ExecutionCommandResult, { ok: false }> {
  return { ok: false, code: "execution_launch_invalid_input", message };
}

function executionIdentity(
  value: unknown,
): { ok: true; value: ExecutionSelectionIdentity } | Extract<ExecutionCommandResult, { ok: false }> {
  if (!isRecord(value)
    || typeof value.transport !== "string"
    || !value.transport.trim()
    || !isRecord(value.platform)
    || typeof value.platform.type !== "string"
    || !value.platform.type.trim()
    || typeof value.platform.version !== "string"
    || !value.platform.version.trim()) {
    return invalidInput("Launch requires a complete execution identity.");
  }
  return {
    ok: true,
    value: {
      transport: value.transport,
      platform: { type: value.platform.type, version: value.platform.version },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
