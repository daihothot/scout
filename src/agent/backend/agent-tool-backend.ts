import type {
  DynamicToolCallInput,
  DynamicToolCallResult,
} from "../../agent-server/types.js";
import type { RuntimeInteractionPort } from "../../interaction/index.js";
import {
  renderUserInputRequestNotification,
} from "../../interaction/protocol/index.js";
import type { ScoutAgent } from "../scout-agent.js";
import { ScoutAgentRoles } from "../types.js";
import type { AgentTaskOutcomeStatus } from "../task/types.js";
import {
  AGENT_TASK_RESULT_TOOL_NAMESPACE,
  AGENT_USER_INPUT_TOOL_NAMESPACE,
  COORDINATOR_TOOL_NAMESPACE,
  parseCoordinatorDynamicToolCall,
  parseRequestUserInputDynamicToolCall,
  parseTaskResultDynamicToolCall,
  type CoordinatorAgentToolCall,
  type RequestUserInputToolCall,
  type TaskResultToolCall,
} from "../tools.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { AgentTaskBackend } from "./agent-task-backend.js";
import type { CoordinatorSyntheticOutput } from "./types.js";

export interface AgentToolBackendOptions {
  runId: string;
  registry: AgentRegistry;
  taskBackend: AgentTaskBackend;
  logger: {
    info(input: unknown): void;
    error(input: unknown): void;
  };
  interactionPort?: RuntimeInteractionPort;
}

export class AgentToolBackend {
  private readonly runId: string;
  private readonly registry: AgentRegistry;
  private readonly taskBackend: AgentTaskBackend;
  private readonly logger: AgentToolBackendOptions["logger"];
  private readonly interactionPort?: RuntimeInteractionPort;
  private syntheticOutput?: CoordinatorSyntheticOutput;

  constructor(options: AgentToolBackendOptions) {
    this.runId = options.runId;
    this.registry = options.registry;
    this.taskBackend = options.taskBackend;
    this.logger = options.logger;
    this.interactionPort = options.interactionPort;
  }

  getSyntheticOutput(): CoordinatorSyntheticOutput | undefined {
    return this.syntheticOutput ? {
      ...this.syntheticOutput,
      evidence: [...this.syntheticOutput.evidence],
    } : undefined;
  }

  async handleDynamicToolCall(input: DynamicToolCallInput): Promise<DynamicToolCallResult> {
    const caller = this.registry.resolveToolCaller(input.threadId);
    if (!caller) {
      return dynamicToolFailure(`Unknown dynamic tool caller thread: ${input.threadId}`);
    }
    if (input.namespace === AGENT_USER_INPUT_TOOL_NAMESPACE) {
      return this.handleRequestUserInputToolCall(input, caller);
    }
    if (input.namespace === AGENT_TASK_RESULT_TOOL_NAMESPACE) {
      return this.handleTaskResultToolCall(input, caller);
    }
    if (input.namespace !== COORDINATOR_TOOL_NAMESPACE) {
      return dynamicToolFailure(`Unsupported dynamic tool namespace: ${input.namespace ?? "null"}`);
    }
    if (caller.role !== ScoutAgentRoles.Coordinator) {
      return dynamicToolFailure(`Dynamic coordinator tools are only available to coordinator threads. Caller role: ${caller.role}`);
    }

    try {
      const call = parseCoordinatorDynamicToolCall(input.tool, input.arguments);
      this.logger.info({
        module: "agent.tool",
        event: "coordinator_tool_call_started",
        agentId: caller.agentId,
        data: {
          tool: input.tool,
          namespace: input.namespace,
          callId: input.callId,
          turnId: input.turnId,
          threadId: input.threadId,
        },
      });
      const result = await this.dispatchCoordinatorToolCall(call, caller);
      this.logger.info({
        module: "agent.tool",
        event: "coordinator_tool_call_completed",
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
        event: "coordinator_tool_call_failed",
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

  private async handleRequestUserInputToolCall(
    input: DynamicToolCallInput,
    caller: ScoutAgent,
  ): Promise<DynamicToolCallResult> {
    try {
      const call = parseRequestUserInputDynamicToolCall(input.tool, input.arguments);
      const request = normalizeUserInputRequest(call, caller);
      const task = caller.role === ScoutAgentRoles.Coordinator
        ? undefined
        : this.taskBackend.resolveAgentTask(caller, call.task_id, "user input request");
      if (task) {
        const updated = caller.task.requestUserInput({
          taskId: task.taskId,
          request: {
            ...request,
            agentId: caller.agentId,
            taskId: task.taskId,
            createdAt: new Date().toISOString(),
          },
        });
        this.taskBackend.syncTaskSnapshot(updated);
        return dynamicToolSuccess({
          status: "queued",
          requestId: request.requestId,
          routedTo: "coordinator",
          taskId: updated.taskId,
        });
      }
      const command = this.taskBackend.enqueueCoordinatorCommand({
        type: "user_input",
        priority: "next",
        sourceTaskId: undefined,
        payload: renderUserInputRequestNotification({
          request: {
            ...request,
            agentId: caller.agentId,
            createdAt: new Date().toISOString(),
          },
        }),
      });
      this.logger.info({
        module: "agent.user_input",
        event: "user_input_request_enqueued",
        agentId: caller.agentId,
        data: {
          commandId: command.id,
          request,
        },
      });
      return dynamicToolSuccess({
        status: "queued",
        commandId: command.id,
        requestId: request.requestId,
        routedTo: "coordinator",
      });
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      this.logger.error({
        module: "agent.user_input",
        event: "user_input_request_failed",
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

  private async handleTaskResultToolCall(
    input: DynamicToolCallInput,
    caller: ScoutAgent,
  ): Promise<DynamicToolCallResult> {
    if (caller.role === ScoutAgentRoles.Coordinator) {
      return dynamicToolFailure("Coordinator must use SyntheticOutput, not TaskResult.");
    }
    try {
      const call = parseTaskResultDynamicToolCall(input.tool, input.arguments);
      const task = this.taskBackend.resolveAgentTask(caller, call.task_id, "task result");
      const outcome = normalizeTaskResult(call);
      const completed = caller.task.completeTaskWithOutcome({
        taskId: task.taskId,
        outcome,
      });
      this.taskBackend.syncTaskSnapshot(completed);
      await this.interactionPort?.disclose({
        level: outcome.status === "complete" ? "info" : outcome.status === "failed" ? "error" : "warn",
        source: `agent.task_result.${caller.agentId}`,
        message: outcome.summary,
        data: {
          runId: this.runId,
          agentId: caller.agentId,
          taskId: completed.taskId,
          role: caller.role,
          outcome: completed.outcome,
        },
      });
      this.logger.info({
        module: "agent.task_result",
        event: "task_outcome_recorded",
        agentId: caller.agentId,
        taskId: completed.taskId,
        data: {
          outcome: completed.outcome,
        },
      });
      return dynamicToolSuccess({
        status: "recorded",
        taskId: completed.taskId,
        agentId: caller.agentId,
        outcome: completed.outcome,
      });
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      this.logger.error({
        module: "agent.task_result",
        event: "task_outcome_failed",
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

  private async dispatchCoordinatorToolCall(
    call: CoordinatorAgentToolCall,
    caller: ScoutAgent,
  ): Promise<Record<string, unknown>> {
    if (call.tool === "AgentTool") {
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

    if (call.tool === "SendMessage") {
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

    if (call.tool === "TaskStop") {
      const task = this.taskBackend.stopAgentTask(call.task_id, call.reason ?? "任务已被 Coordinator 停止。");
      return {
        status: "stopped",
        taskId: task.taskId,
        agentId: task.agentId,
      };
    }

    const syntheticOutput: CoordinatorSyntheticOutput = {
      status: call.status,
      summary: call.summary,
      evidence: call.evidence ?? [],
      blocker: call.blocker,
      emittedAt: new Date().toISOString(),
      coordinatorThreadId: caller.threadId ?? caller.agentId,
    };
    this.syntheticOutput = syntheticOutput;
    this.taskBackend.enqueueCoordinatorCommand({
      type: "system_event",
      priority: call.status === "complete" || call.status === "blocked" || call.status === "failed" ? "now" : "next",
      payload: JSON.stringify({
        type: "coordinator_synthetic_output",
        ...syntheticOutput,
      }),
    });
    this.logger.info({
      module: "agent.tool",
      event: "synthetic_output",
      agentId: caller.agentId,
      data: call,
    });
    return {
      status: "recorded",
      syntheticStatus: call.status,
      summary: call.summary,
    };
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

function normalizeTaskResult(call: TaskResultToolCall): {
  status: AgentTaskOutcomeStatus;
  summary: string;
  artifactRefs: string[];
  evidenceRefs: string[];
  blocker?: string;
  nextStep?: string;
} {
  const validStatuses = new Set<AgentTaskOutcomeStatus>([
    "complete",
    "prompt_required",
    "confirmation_required",
    "blocked",
    "insufficient_evidence",
    "failed",
  ]);
  if (!validStatuses.has(call.status)) {
    throw new Error(`Invalid TaskResult status: ${String(call.status)}`);
  }
  if (typeof call.summary !== "string") {
    throw new Error("TaskResult requires a string summary.");
  }
  const summary = call.summary.trim();
  if (summary.length === 0 || summary.length > 2000) {
    throw new Error("TaskResult summary must be 1-2000 characters.");
  }
  const artifactRefs = readOptionalStringArray(call.artifact_refs, "artifact_refs")
    ?.map((item) => item.trim())
    .filter((item) => item.length > 0) ?? [];
  const evidenceRefs = readOptionalStringArray(call.evidence_refs, "evidence_refs")
    ?.map((item) => item.trim())
    .filter((item) => item.length > 0) ?? [];
  const blocker = typeof call.blocker === "string" && call.blocker.trim().length > 0
    ? call.blocker.trim()
    : undefined;
  const nextStep = typeof call.next_step === "string" && call.next_step.trim().length > 0
    ? call.next_step.trim()
    : undefined;
  if (call.status === "complete" && evidenceRefs.length === 0) {
    throw new Error("TaskResult complete requires at least one evidence_ref.");
  }
  if (call.status !== "complete" && !blocker && !nextStep) {
    throw new Error("Non-complete TaskResult requires blocker or next_step.");
  }
  return {
    status: call.status,
    summary,
    artifactRefs,
    evidenceRefs,
    blocker,
    nextStep,
  };
}

function normalizeUserInputRequest(call: RequestUserInputToolCall, caller: ScoutAgent): {
  requestId: string;
  kind: "prompt_required" | "confirmation_required";
  question: string;
  context?: string;
  options?: string[];
} {
  if (typeof call.question !== "string") {
    throw new Error("RequestUserInput requires a string question.");
  }
  const question = call.question.trim();
  if (question.length === 0 || question.length > 1000) {
    throw new Error("RequestUserInput question must be 1-1000 characters.");
  }
  const context = typeof call.context === "string" && call.context.trim().length > 0
    ? call.context.trim()
    : undefined;
  const options = readOptionalStringArray(call.options, "options")
    ?.map((option) => option.trim())
    .filter((option) => option.length > 0);
  if (options && options.length > 20) {
    throw new Error("RequestUserInput options must contain at most 20 items.");
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
