import { readArtifactReference } from "../../../../../../core/io/index.js";
import type { DynamicToolCallResponse } from "../../../../../../agent-server/types.js";
import type { AgentJsonValue } from "../../../../../../agent/tools/types.js";
import type { DomainAgentTool } from "../../../../../agent/index.js";
import type { ScoutDomainDynamicToolCall } from "../../../../../types.js";
import {
  JarvisBehaviorOrchestrator,
  type JarvisBehaviorPhase,
} from "../../../core/jarvis-behavior-orchestrator.js";

const EXECUTE_QUERY_COMMANDS = new Set([
  "behavior.registry.nodes",
  "behavior.node.variants",
  "behavior.evidence.sources",
  "behavior.trigger.commands",
]);
const REVIEW_QUERY_COMMANDS = new Set([
  "behavior.campaign.query",
  "behavior.evidence.query",
]);

/** Owns the Agent-facing RBT Behavior input boundary and delegates core work. */
export class JarvisBehaviorTool implements DomainAgentTool {
  constructor(
    private readonly phase: JarvisBehaviorPhase,
    private readonly orchestrator: JarvisBehaviorOrchestrator,
  ) {}

  async execute(call: ScoutDomainDynamicToolCall): Promise<DynamicToolCallResponse> {
    try {
      return await this.executeInput(call);
    } catch (error) {
      return failedToolResponse(
        "invalid_dynamic_tool_input",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async executeInput(call: ScoutDomainDynamicToolCall): Promise<DynamicToolCallResponse> {
    const input = requireObject(call.input.arguments, "JarvisBehavior arguments");
    const hasExecuteFile = Object.hasOwn(input, "execute_file");
    const hasCommand = Object.hasOwn(input, "command") || Object.hasOwn(input, "payload");
    if (hasExecuteFile === hasCommand) throw new Error("Provide either execute_file or command + payload.");

    if (hasExecuteFile) {
      if (this.phase !== "execute") {
        return failedToolResponse("command_not_available", "execute_file is not available in the current RBT Phase.");
      }
      const unexpectedKeys = Object.keys(input).filter((key) => key !== "execute_file");
      if (unexpectedKeys.length > 0) throw new Error(`execute_file input contains unsupported fields: ${unexpectedKeys.join(", ")}.`);
      return this.orchestrator.executeFile(call, readArtifactReference(input.execute_file));
    }

    const unexpectedKeys = Object.keys(input).filter((key) => key !== "command" && key !== "payload");
    if (unexpectedKeys.length > 0) throw new Error(`Behavioral query contains unsupported fields: ${unexpectedKeys.join(", ")}.`);
    if (typeof input.command !== "string" || input.command.length === 0) throw new Error("command must be a non-empty string.");
    const allowed = this.phase === "execute" ? EXECUTE_QUERY_COMMANDS : REVIEW_QUERY_COMMANDS;
    if (!allowed.has(input.command)) {
      return failedToolResponse("command_not_available", `Behavioral command ${input.command} is not available in the current RBT Phase.`);
    }
    const payload = toJsonObject(requireObject(input.payload, "Behavioral query payload"));
    return this.orchestrator.executeCommand(this.phase, call, input.command, payload);
  }
}

function failedToolResponse(code: string, message: string): DynamicToolCallResponse {
  return dynamicResponse(false, { status: "failed", error: { code, message } });
}

function dynamicResponse(success: boolean, output: AgentJsonValue): DynamicToolCallResponse {
  return { success, contentItems: [{ type: "inputText", text: JSON.stringify(output, null, 2) }] };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function toJsonObject(value: Record<string, unknown>): Record<string, AgentJsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]));
}

function toJsonValue(value: unknown): AgentJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) return toJsonObject(value);
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
