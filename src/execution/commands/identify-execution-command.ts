import type { ExecutionCommand, ExecutionCommandResult } from "../execution-command.js";
import type { ExecutionHandler, ExecutionHandlerValue } from "../execution-handler.js";

/** Discovers one AppPilot transport and platform selection. */
export class IdentifyExecutionCommand implements ExecutionCommand {
  readonly operation = "identify";

  constructor(private readonly handler: ExecutionHandler) {}

  async invoke(input: unknown): Promise<ExecutionCommandResult> {
    if (!isRecord(input)) return invalidInput("Identify parameters must be an object.");
    const unexpected = Object.keys(input).filter(
      (key) => key !== "transport" && key !== "platform",
    );
    if (unexpected.length > 0) {
      return invalidInput(`Identify received unsupported parameter(s): ${unexpected.join(", ")}.`);
    }
    const transport = optionalString(input.transport, "transport");
    if (!transport.ok) return transport;
    const platform = optionalString(input.platform, "platform");
    if (!platform.ok) return platform;

    const result = await this.handler.invoke({
      operation: this.operation,
      parameters: {
        ...(transport.value ? { transport: transport.value } : {}),
      },
    });
    if (!result.ok) return result;
    const selection = parseSelection(result.value);
    if (!selection) {
      return {
        ok: false,
        code: "apppilot_invalid_response",
        message: "AppPilot identify returned an invalid execution identity.",
      };
    }
    if (platform.value && selection.platform.type !== platform.value) {
      return {
        ok: false,
        code: "execution_platform_mismatch",
        message: `AppPilot discovered ${selection.platform.type}, expected ${platform.value}.`,
      };
    }
    return { ok: true, selection };
  }
}

function parseSelection(value: ExecutionHandlerValue | undefined) {
  if (!isRecord(value)
    || typeof value.transport !== "string"
    || value.transport.length === 0
    || !isRecord(value.platform)
    || typeof value.platform.type !== "string"
    || value.platform.type.length === 0
    || typeof value.platform.version !== "string"
    || value.platform.version.length === 0) {
    return undefined;
  }
  return {
    transport: value.transport,
    platform: {
      type: value.platform.type,
      version: value.platform.version,
    },
  };
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
  return { ok: false, code: "execution_identify_invalid_input", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
