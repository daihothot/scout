import type {
  DynamicToolCallInput,
  DynamicToolCallResult,
} from "../../agent-server/types.js";
import type { ScoutDomain } from "../../domain/index.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import { ScoutAgentRoles } from "../model/types.js";
import {
  SYSTEM_TOOL_NAMESPACE,
  parseSystemDynamicToolCall,
  type RequestHumanInputToolCall,
  type SystemToolCall,
} from "../tools/system-tools.js";
import type { AgentRegistry } from "../lifecycle/agent-registry.js";
import type { AgentTaskBackend } from "./agent-task-backend.js";

export interface AgentToolBackendOptions {
  registry: AgentRegistry;
  taskBackend: AgentTaskBackend;
  domain: ScoutDomain;
  logger: {
    info(input: unknown): void;
    error(input: unknown): void;
  };
}

export class AgentToolBackend {
  private readonly registry: AgentRegistry;
  private readonly taskBackend: AgentTaskBackend;
  private readonly domain: ScoutDomain;
  private readonly logger: AgentToolBackendOptions["logger"];

  constructor(options: AgentToolBackendOptions) {
    this.registry = options.registry;
    this.taskBackend = options.taskBackend;
    this.domain = options.domain;
    this.logger = options.logger;
  }

  async handleDynamicToolCall(input: DynamicToolCallInput): Promise<DynamicToolCallResult> {
    const caller = this.registry.resolveToolCaller(input.threadId);
    if (!caller) {
      return dynamicToolFailure(`Unknown dynamic tool caller thread: ${input.threadId}`);
    }
    if (input.namespace !== SYSTEM_TOOL_NAMESPACE) {
      return this.handleDomainToolCall(input, caller);
    }

    try {
      const call = parseSystemDynamicToolCall(input.tool, input.arguments);
      this.logger.info({
        module: "agent.tool",
        event: "system_tool_call_started",
        agentId: caller.agentId,
        data: {
          tool: input.tool,
          namespace: input.namespace,
          callId: input.callId,
          turnId: input.turnId,
          threadId: input.threadId,
        },
      });
      const result = await this.dispatchSystemToolCall(call, caller, input);
      this.logger.info({
        module: "agent.tool",
        event: "system_tool_call_completed",
        agentId: caller.agentId,
        data: {
          tool: input.tool,
          callId: input.callId,
          result,
        },
      });
      return dynamicToolSuccess(result);
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      this.logger.error({
        module: "agent.tool",
        event: "system_tool_call_failed",
        agentId: caller.agentId,
        data: {
          tool: input.tool,
          callId: input.callId,
          error: message,
        },
      });
      return dynamicToolFailure(message);
    }
  }

  private async handleDomainToolCall(
    input: DynamicToolCallInput,
    caller: ScoutAgent,
  ): Promise<DynamicToolCallResult> {
    if (!this.domain.handleDynamicToolCall) {
      return dynamicToolFailure(`Unsupported dynamic tool namespace: ${input.namespace ?? "null"}`);
    }

    try {
      const result = await this.domain.handleDynamicToolCall({
        input,
        caller: {
          agentId: caller.agentId,
          role: caller.role,
          threadId: caller.threadId,
        },
      });
      if (!result) {
        return dynamicToolFailure(`Unsupported dynamic tool namespace: ${input.namespace ?? "null"}`);
      }
      this.logger.info({
        module: "agent.tool.domain",
        event: "domain_tool_call_completed",
        agentId: caller.agentId,
        data: {
          domainId: this.domain.domainId,
          namespace: input.namespace,
          tool: input.tool,
          callId: input.callId,
          turnId: input.turnId,
          threadId: input.threadId,
          success: result.success,
        },
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      this.logger.error({
        module: "agent.tool.domain",
        event: "domain_tool_call_failed",
        agentId: caller.agentId,
        data: {
          domainId: this.domain.domainId,
          namespace: input.namespace,
          tool: input.tool,
          callId: input.callId,
          error: message,
        },
      });
      return dynamicToolFailure(message);
    }
  }

  private async handleRequestHumanInputToolCall(
    call: RequestHumanInputToolCall,
    input: DynamicToolCallInput,
    caller: ScoutAgent,
  ): Promise<Record<string, unknown>> {
    try {
      const request = normalizeHumanInputRequest(call, caller);
      const task = caller.role === ScoutAgentRoles.Coordinator
        ? undefined
        : this.taskBackend.resolveAgentTask(caller, call.task_id, "human input request");
      if (task) {
        const updated = caller.task.requestUserInput({
          taskId: task.taskId,
          request: {
            ...request,
            agentId: caller.agentId,
            taskId: task.taskId,
            turnId: input.turnId,
            createdAt: new Date().toISOString(),
            status: "pending",
          },
        });
        this.taskBackend.syncTaskSnapshot(updated);
        return {
          status: "recorded",
          requestId: request.requestId,
          routedTo: "coordinator",
          taskId: updated.taskId,
          instruction: "Human input request recorded. Stop this turn now. Do not continue work until Coordinator resumes the task.",
        };
      }
      throw new Error("RequestHumanInput requires an active non-coordinator task.");
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      this.logger.error({
        module: "agent.human_input",
        event: "human_input_request_failed",
        agentId: caller.agentId,
        data: {
          tool: input.tool,
          callId: input.callId,
          error: message,
        },
      });
      throw new Error(message);
    }
  }

  private async dispatchSystemToolCall(
    call: SystemToolCall,
    caller: ScoutAgent,
    input: DynamicToolCallInput,
  ): Promise<Record<string, unknown>> {
    switch (call.tool) {
      case "RequestHumanInput":
        return this.handleRequestHumanInputToolCall(call, input, caller);
      case "AgentTool": {
        this.requireCoordinatorToolCaller(caller, call.tool);
        const task = this.taskBackend.assignAgentTask({
          agentId: call.agent_id,
          description: call.description,
          subagentType: call.subagent_type,
          prompt: call.prompt,
          parentTaskId: caller.threadId ?? caller.agentId,
          isBackgrounded: true,
        });
        return {
          status: call.agent_id ? "assigned" : "spawned",
          taskId: task.taskId,
          agentId: task.agentId,
          role: task.role,
          description: task.description,
        };
      }
      case "SendMessage": {
        this.requireCoordinatorToolCaller(caller, call.tool);
        const task = this.taskBackend.sendAgentMessage({
          target: call.to,
          message: call.message,
        });
        return {
          status: "queued",
          taskId: task.taskId,
          agentId: task.agentId,
        };
      }
      default:
        throw new Error(`Unsupported system tool: ${String((call as { tool?: unknown }).tool)}`);
    }
  }

  private requireCoordinatorToolCaller(caller: ScoutAgent, tool: string): void {
    if (caller.role !== ScoutAgentRoles.Coordinator) {
      throw new Error(`${tool} is only available to coordinator threads. Caller role: ${caller.role}`);
    }
  }
}

function dynamicToolSuccess(value: unknown): DynamicToolCallResult {
  return {
    success: true,
    contentItems: [{
      type: "inputText",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
  };
}

function dynamicToolFailure(message: string): DynamicToolCallResult {
  return {
    success: false,
    contentItems: [{
      type: "inputText",
      text: message,
    }],
  };
}

function normalizeHumanInputRequest(call: RequestHumanInputToolCall, caller: ScoutAgent): {
  requestId: string;
  kind: "prompt_required" | "confirmation_required";
  question: string;
  context?: string;
  options?: string[];
} {
  if (typeof call.question !== "string") {
    throw new Error("RequestHumanInput requires a string question.");
  }
  const question = call.question.trim();
  if (question.length === 0 || question.length > 1000) {
    throw new Error("RequestHumanInput question must be 1-1000 characters.");
  }
  const context = typeof call.context === "string" && call.context.trim().length > 0
    ? call.context.trim()
    : undefined;
  const options = readOptionalStringArray(call.options, "options")
    ?.map((option) => option.trim())
    .filter((option) => option.length > 0);
  if (options && options.length > 20) {
    throw new Error("RequestHumanInput options must contain at most 20 items.");
  }
  return {
    requestId: `${caller.agentId}-input-${Date.now()}`,
    kind: call.kind === "confirmation_required" ? "confirmation_required" : "prompt_required",
    question,
    context,
    options: options && options.length > 0 ? options : undefined,
  };
}

function readOptionalStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${fieldName} must be a string array.`);
  }
  return [...value];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
