import type {
  ExecutionCommand,
  ExecutionCommandResult,
  ExecutionSelectionIdentity,
} from "../execution-command.js";
import type { ExecutionHandler } from "../execution-handler.js";

/** Stops the application represented by the caller-owned execution identity. */
export class ShutdownExecutionCommand implements ExecutionCommand {
  readonly operation = "shutdown";

  constructor(private readonly handler: ExecutionHandler) {}

  async invoke(input: unknown): Promise<ExecutionCommandResult> {
    if (!isRecord(input)) return invalidInput("Shutdown parameters must be an object.");
    const unexpected = Object.keys(input).filter(
      (key) => key !== "identity" && key !== "appId",
    );
    if (unexpected.length > 0) {
      return invalidInput(`Shutdown received unsupported parameter(s): ${unexpected.join(", ")}.`);
    }
    const appId = optionalString(input.appId, "appId");
    if (!appId.ok) return appId;
    const selection = executionIdentity(input.identity);
    if (!selection.ok) return selection;
    if (selection.value.platform.type === "android" && !appId.value) {
      return invalidInput("Android shutdown requires appId.");
    }

    const result = await this.handler.invoke({
      operation: this.operation,
      identity: selection.value,
      parameters: {
        ...(appId.value ? { appId: appId.value } : {}),
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
  return { ok: false, code: "execution_shutdown_invalid_input", message };
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
    return invalidInput("Shutdown requires a complete execution identity.");
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
