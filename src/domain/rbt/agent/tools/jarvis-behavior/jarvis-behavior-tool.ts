import type { DynamicToolCallResponse } from "../../../../../agent-server/types.js";
import type { AgentJsonValue } from "../../../../../agent/tools/types.js";
import type { ExecutionPlatformRequest } from "../../../../../execution/execution-command.js";
import type { ScoutDomainDynamicToolCall } from "../../../../types.js";
import type { RbtAgentDynamicTool } from "../agent-tools.js";
import { JarvisWebSocketTool } from "../jarvis-websocket/index.js";
import { JarvisBehaviorCommandRunner } from "../../../core/jarvis-behavior-command-runner.js";
import { JarvisBehaviorExecutionTargetGate } from "../../../core/jarvis-behavior-execution-target-gate.js";
import { JarvisBehaviorExecuteFileRunner } from "../../../core/jarvis-behavior-execute-file.js";
import { JarvisBehaviorOrchestrator } from "../../../core/jarvis-behavior-orchestrator.js";
import { JarvisBehaviorToolStore } from "../../../core/jarvis-behavior-tool-store.js";
import { JarvisBehaviorWebSocketLinker } from "../../../core/jarvis-behavior-websocket-linker.js";

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

type JarvisBehaviorPhase = "execute" | "review";

/** Owns the Agent-facing RBT Behavior input boundary and delegates core work. */
export class JarvisBehaviorTool implements RbtAgentDynamicTool {
  private readonly orchestrator: JarvisBehaviorOrchestrator;

  constructor(
    private readonly phase: JarvisBehaviorPhase,
    private readonly executable = "jarvis",
    private readonly baseArgs: readonly string[] = [],
    private readonly store = new JarvisBehaviorToolStore(),
    private readonly websocket = new JarvisWebSocketTool(),
    executionRequest: () => ExecutionPlatformRequest = () => ({}),
    executionTargetGate = new JarvisBehaviorExecutionTargetGate(),
  ) {
    const commandRunner = new JarvisBehaviorCommandRunner(
      this.phase,
      this.executable,
      this.baseArgs,
      this.store,
    );
    this.orchestrator = new JarvisBehaviorOrchestrator(
      executionRequest,
      executionTargetGate,
      new JarvisBehaviorWebSocketLinker(
        this.phase,
        this.executable,
        this.baseArgs,
        this.websocket,
      ),
      commandRunner,
      new JarvisBehaviorExecuteFileRunner(this.store),
      this.store,
    );
  }

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

  async stop(): Promise<void> {
    this.store.clear();
    this.orchestrator.stop();
    await this.websocket.stop();
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
      if (typeof input.execute_file !== "string" || input.execute_file.trim().length === 0) {
        throw new Error("execute_file must be a non-empty path.");
      }
      return this.orchestrator.executeFile(call, input.execute_file);
    }

    const unexpectedKeys = Object.keys(input).filter((key) => key !== "command" && key !== "payload");
    if (unexpectedKeys.length > 0) throw new Error(`Behavioral query contains unsupported fields: ${unexpectedKeys.join(", ")}.`);
    if (typeof input.command !== "string" || input.command.length === 0) throw new Error("command must be a non-empty string.");
    const allowed = this.phase === "execute" ? EXECUTE_QUERY_COMMANDS : REVIEW_QUERY_COMMANDS;
    if (!allowed.has(input.command)) {
      return failedToolResponse("command_not_available", `Behavioral command ${input.command} is not available in the current RBT Phase.`);
    }
    const payload = toJsonObject(requireObject(input.payload, "Behavioral query payload"));
    return this.orchestrator.executeCommand(call, input.command, payload);
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
