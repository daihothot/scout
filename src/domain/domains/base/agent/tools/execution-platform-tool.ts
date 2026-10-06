import type { DynamicToolCallResponse } from "../../../../../agent-server/types.js";
import type { DomainAgentTool } from "../../../../agent/index.js";
import { ScoutDomainId, type ScoutDomainDynamicToolCall } from "../../../../types.js";
import { currentRunScope } from "../../../../../run/run-scope.js";
import { BaseDomain } from "../../base-domain.js";

type ExecutionPlatformOperation = "launch" | "shutdown";
/** Dispatches Agent operation semantics to the Base Domain execution runtime. */
export class ExecutionPlatformTool implements DomainAgentTool {
  async execute(
    call: ScoutDomainDynamicToolCall,
  ): Promise<DynamicToolCallResponse> {
    const input = call.input.arguments;
    if (!isRecord(input)) {
      return response(false, {
        operation: "unknown",
        status: "failed",
        code: "execution_platform_invalid_input",
        message: "ExecutionPlatform arguments must be an object.",
      });
    }
    const operation = input.operation;
    if (operation !== "launch" && operation !== "shutdown") {
      return response(false, {
        operation: typeof operation === "string" ? operation : "unknown",
        status: "failed",
        code: "execution_platform_invalid_operation",
        message: "ExecutionPlatform operation must be launch or shutdown.",
      });
    }
    if (Object.keys(input).some((key) => key !== "operation")) {
      return response(false, {
        operation,
        status: "failed",
        code: "execution_platform_invalid_input",
        message: "ExecutionPlatform accepts only the operation field.",
      });
    }
    const domain = currentRunScope().domainRegistry.get(ScoutDomainId.Base);
    if (!(domain instanceof BaseDomain)) throw new Error("Registered Base Domain has an invalid runtime type.");
    const result = operation === "launch"
      ? await domain.execution.launch()
      : await domain.execution.shutdown();
    return result.ok
      ? response(true, { operation, status: "completed", identity: result.identity.platform })
      : failure(operation, result.code, result.message);
  }
}

function failure(
  operation: ExecutionPlatformOperation,
  code: string,
  message: string,
): DynamicToolCallResponse {
  return response(false, { operation, status: "failed", code, message });
}

function response(success: boolean, output: object): DynamicToolCallResponse {
  return {
    success,
    contentItems: [{ type: "inputText", text: JSON.stringify(output, null, 2) }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
