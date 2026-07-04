import type {
  DynamicToolCallInput,
  DynamicToolCallResult,
} from "../../agent-server/types.js";
import type { ScoutDomain } from "../../domain/index.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import { ScoutAgentRoles } from "../thread/types.js";
import {
  type AssignTaskToolCall,
  AGENT_TOOL_NAMESPACES,
  parseAgentDynamicToolCall,
  type RequestHumanInputToolCall,
  type SendMessageToolCall,
  type SubmitTaskToolCall,
  type AgentDynamicToolCall,
} from "../tools/agent-tools.js";
import type { AgentRegistry } from "../core/agent-registry.js";
import type { AgentTaskBackend } from "./agent-task-backend.js";
import type { AgentTaskStore } from "../task/agent-task-store.js";
import type { AgentProvider } from "./types.js";
import {
  AgentTaskOutcomeStatuses,
  AgentTaskStatuses,
  type AgentTaskState,
} from "../task/types.js";
import type { WorkerAgent } from "../roles/worker-agent.js";
import { agent } from "../context/agent-attachments.js";

export interface AgentToolBackendOptions {
  registry: AgentRegistry;
  taskStore: AgentTaskStore;
  taskBackend: AgentTaskBackend;
  agentProvider: AgentProvider;
  domain: ScoutDomain;
  logger: {
    info(input: unknown): void;
    error(input: unknown): void;
  };
}

export class AgentToolBackend {
  private readonly registry: AgentRegistry;
  private readonly taskStore: AgentTaskStore;
  private readonly taskBackend: AgentTaskBackend;
  private readonly agentProvider: AgentProvider;
  private readonly domain: ScoutDomain;
  private readonly logger: AgentToolBackendOptions["logger"];

  constructor(options: AgentToolBackendOptions) {
    this.registry = options.registry;
    this.taskStore = options.taskStore;
    this.taskBackend = options.taskBackend;
    this.agentProvider = options.agentProvider;
    this.domain = options.domain;
    this.logger = options.logger;
  }

  async handleDynamicToolCall(input: DynamicToolCallInput): Promise<DynamicToolCallResult> {
    const caller = this.registry.resolveToolCaller(input.threadId);
    if (!caller) {
      return dynamicToolFailure(`Unknown dynamic tool caller thread: ${input.threadId}`);
    }
    if (!input.namespace || !AGENT_TOOL_NAMESPACES.has(input.namespace)) {
      return this.handleDomainToolCall(input, caller);
    }

    try {
      const call = parseAgentDynamicToolCall(input.tool, input.arguments);
      this.logger.info({
        module: "agent.tool",
        event: "agent_tool_call_started",
        agentId: caller.agentId,
        data: {
          tool: input.tool,
          namespace: input.namespace,
          callId: input.callId,
          turnId: input.turnId,
          threadId: input.threadId,
        },
      });
      const result = await this.dispatchAgentDynamicToolCall(call, caller, input);
      this.logger.info({
        module: "agent.tool",
        event: "agent_tool_call_completed",
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
        event: "agent_tool_call_failed",
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
    const readQuestion = (): string => {
      if (typeof call.question !== "string") {
        throw new Error("RequestHumanInput question must be a string.");
      }
      const question = call.question.trim();
      if (question.length === 0 || question.length > 1000) {
        throw new Error("RequestHumanInput question must be 1-1000 characters.");
      }
      return question;
    };
    const readContext = (): string | undefined =>
      typeof call.context === "string" && call.context.trim().length > 0 ? call.context.trim() : undefined;
    const readOptions = (): string[] | undefined => {
      if (call.options === undefined) return undefined;
      if (!Array.isArray(call.options) || !call.options.every((item) => typeof item === "string")) {
        throw new Error("options must be a string array.");
      }
      const options = call.options.map((item) => item.trim()).filter((item) => item.length > 0);
      if (options.length > 20) {
        throw new Error("options must contain at most 20 items.");
      }
      return options.length > 0 ? options : undefined;
    };

    try {
      const task = caller.role === ScoutAgentRoles.Coordinator
        ? undefined
        : this.taskBackend.resolveAgentTask(caller, call.task_id, "human input request");
      if (task) {
        const requestId = `${caller.agentId}-input-${Date.now()}`;
        const updated = caller.runner.requestHumanInput({
          taskId: task.taskId,
          request: {
            requestId,
            kind: call.kind === "confirmation_required" ? "confirmation_required" : "prompt_required",
            question: readQuestion(),
            context: readContext(),
            options: readOptions(),
            agentId: caller.agentId,
            taskId: task.taskId,
            turnId: input.turnId,
            createdAt: new Date().toISOString(),
            status: "pending",
          },
        });
        return {
          status: "accepted",
          requestId,
          routedTo: "coordinator",
          taskId: updated.taskId,
          instruction: "Human input request accepted. Stop this turn now. Do not continue work until Coordinator resumes the task.",
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

  private handleAssignTaskToolCall(
    call: AssignTaskToolCall,
  ): Record<string, unknown> {
    const worker = this.resolveAssignableWorker(call);
    const task = worker.assignTask({
      agentId: worker.agentId,
      description: call.description,
      subagentType: call.subagent_type,
      prompt: agent.turn.message(call.prompt),
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

  private handleSubmitTaskToolCall(
    call: SubmitTaskToolCall,
    caller: ScoutAgent,
  ): Record<string, unknown> {
    if (caller.role === ScoutAgentRoles.Coordinator) {
      throw new Error("SubmitTask requires an active non-coordinator task.");
    }
    const task = this.taskBackend.resolveAgentTask(caller, call.task_id, "submit task");
    const status = readSubmitTaskStatus(call.status);
    const summary = readSubmitTaskSummary(call.summary);
    const completed = caller.runner.completeTaskWithOutcome({
      taskId: task.taskId,
      outcome: {
        status,
        summary,
        artifactRefs: [],
        evidenceRefs: [],
        blocker: status === AgentTaskOutcomeStatuses.Complete ? undefined : summary,
        nextStep: status === AgentTaskOutcomeStatuses.Complete ? undefined : summary,
      },
    });
    return {
      status: "accepted",
      taskId: completed.taskId,
      agentId: completed.agentId,
      taskStatus: completed.status,
      outcome: completed.outcome,
    };
  }

  private handleSendMessageToolCall(
    call: SendMessageToolCall,
  ): Record<string, unknown> {
    const target = this.resolveMessageTarget(call.to);
    const type = call.type ?? "message";
    if (type === "human_response" && target.task.status !== AgentTaskStatuses.WaitingForHumanInput) {
      throw new Error(`Cannot send human_response to task ${target.task.taskId}. Status: ${target.task.status}.`);
    }
    const task = target.agent.runner.queueMessage({
      taskId: target.task.taskId,
      message: type === "human_response"
        ? agent.turn.human_response(call.message)
        : agent.turn.message(call.message),
    });
    return {
      status: "queued",
      taskId: task.taskId,
      agentId: task.agentId,
    };
  }

  private async dispatchAgentDynamicToolCall(
    call: AgentDynamicToolCall,
    caller: ScoutAgent,
    input: DynamicToolCallInput,
  ): Promise<Record<string, unknown>> {
    switch (call.tool) {
      case "RequestHumanInput":
        return this.handleRequestHumanInputToolCall(call, input, caller);
      case "AssignTask":
        return this.handleAssignTaskToolCall(call);
      case "SendMessage":
        return this.handleSendMessageToolCall(call);
      case "SubmitTask":
        return this.handleSubmitTaskToolCall(call, caller);
      default:
        throw new Error(`Unsupported agent tool: ${String((call as { tool?: unknown }).tool)}`);
    }
  }

  private resolveMessageTarget(target: string): { agent: ScoutAgent; task: AgentTaskState } {
    const task = this.taskStore.getTask(target);
    if (task) {
      return {
        agent: this.registry.resolveAgent(task.agentId),
        task,
      };
    }
    const agent = this.registry.resolveAgent(target);
    const active = this.taskStore.findActiveTaskForAgent(agent.agentId);
    if (!active) {
      throw new Error(`Agent ${agent.agentId} has no active task.`);
    }
    return {
      agent,
      task: active,
    };
  }

  private resolveAssignableWorker(call: AssignTaskToolCall): WorkerAgent {
    const worker = call.agent_id
      ? this.registry.resolveAgent(call.agent_id) as WorkerAgent
      : this.agentProvider.resolveWorker({
        role: call.subagent_type,
      });
    if (worker.role !== call.subagent_type) {
      throw new Error(`Agent ${worker.agentId} is ${worker.role}, not ${call.subagent_type}.`);
    }
    return worker;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSubmitTaskStatus(value: SubmitTaskToolCall["status"]): typeof AgentTaskOutcomeStatuses[keyof typeof AgentTaskOutcomeStatuses] {
  if (value === AgentTaskOutcomeStatuses.Complete) return AgentTaskOutcomeStatuses.Complete;
  if (value === AgentTaskOutcomeStatuses.Blocked) return AgentTaskOutcomeStatuses.Blocked;
  if (value === AgentTaskOutcomeStatuses.Failed) return AgentTaskOutcomeStatuses.Failed;
  throw new Error("SubmitTask status must be complete, blocked, or failed.");
}

function readSubmitTaskSummary(value: SubmitTaskToolCall["summary"]): string {
  if (typeof value !== "string") {
    throw new Error("SubmitTask summary must be a string.");
  }
  const summary = value.trim();
  if (summary.length === 0 || summary.length > 4000) {
    throw new Error("SubmitTask summary must be 1-4000 characters.");
  }
  return summary;
}
