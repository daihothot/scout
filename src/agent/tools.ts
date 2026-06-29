import type { AgentDynamicToolSpec, AgentJsonValue, ScoutAgentRole } from "./types.js";
import { ScoutAgentRoles } from "./types.js";

export const COORDINATOR_TOOL_NAMESPACE = "scout";
export const AGENT_USER_INPUT_TOOL_NAMESPACE = "scout.user_input";
export const AGENT_TASK_RESULT_TOOL_NAMESPACE = "scout.task_result";

export interface AgentToolCall {
  tool: "AgentTool";
  agent_id?: string;
  description: string;
  subagent_type: Exclude<ScoutAgentRole, typeof ScoutAgentRoles.Coordinator>;
  prompt: string;
}

export interface SendMessageToolCall {
  tool: "SendMessage";
  to: string;
  message: string;
}

export interface TaskStopToolCall {
  tool: "TaskStop";
  task_id: string;
  reason?: string;
}

export interface SyntheticOutputToolCall {
  tool: "SyntheticOutput";
  status: "in_progress" | "complete" | "blocked" | "failed";
  summary: string;
  evidence?: string[];
  blocker?: string;
}

export type CoordinatorAgentToolCall =
  | AgentToolCall
  | SendMessageToolCall
  | TaskStopToolCall
  | SyntheticOutputToolCall;

export interface RequestUserInputToolCall {
  tool: "RequestUserInput";
  task_id?: string;
  kind?: "prompt_required" | "confirmation_required";
  question: string;
  context?: string;
  options?: string[];
}

export interface TaskResultToolCall {
  tool: "TaskResult";
  task_id?: string;
  status:
    | "complete"
    | "prompt_required"
    | "confirmation_required"
    | "blocked"
    | "insufficient_evidence"
    | "failed";
  summary: string;
  artifact_refs?: string[];
  evidence_refs?: string[];
  blocker?: string;
  next_step?: string;
}

export function buildAgentToolDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: COORDINATOR_TOOL_NAMESPACE,
    name: "AgentTool",
    description: "创建或复用一个 Scout researcher、verifier 或 validator worker agent，并分配一个新任务。",
    inputSchema: objectSchema({
      agent_id: {
        type: "string",
        description: "可选。已有 agent id；为空时创建新的 Scout agent。",
      },
      description: {
        type: "string",
        description: "任务通知中显示的简短任务说明。",
      },
      subagent_type: {
        type: "string",
        enum: [ScoutAgentRoles.Researcher, ScoutAgentRoles.Verifier, ScoutAgentRoles.Validator],
        description: "需要启动的 Scout agent 角色。",
      },
      prompt: {
        type: "string",
        description: "传给被启动 agent 的完整中文指令。",
      },
    }, ["description", "subagent_type", "prompt"]),
  };
}

export function buildSendMessageDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: COORDINATOR_TOOL_NAMESPACE,
    name: "SendMessage",
    description: "给已有 Scout agent 任务追加一条后续消息。",
    inputSchema: objectSchema({
      to: {
        type: "string",
        description: "目标 task id 或 agent id。",
      },
      message: {
        type: "string",
        description: "注入到该 agent 下一轮循环的中文消息。",
      },
    }, ["to", "message"]),
  };
}

export function buildTaskStopDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: COORDINATOR_TOOL_NAMESPACE,
    name: "TaskStop",
    description: "停止一个已有 Scout agent 任务。",
    inputSchema: objectSchema({
      task_id: {
        type: "string",
        description: "需要停止的 task id 或 agent id。",
      },
      reason: {
        type: "string",
        description: "可选的中文停止原因，会出现在任务通知中。",
      },
    }, ["task_id"]),
  };
}

export function buildSyntheticOutputDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: COORDINATOR_TOOL_NAMESPACE,
    name: "SyntheticOutput",
    description: "向 Scout runtime 报告综合状态或最终结果。",
    inputSchema: objectSchema({
      status: {
        type: "string",
        enum: ["in_progress", "complete", "blocked", "failed"],
        description: "综合状态。",
      },
      summary: {
        type: "string",
        description: "简洁的中文综合报告。",
      },
      evidence: {
        type: "array",
        items: { type: "string" },
        description: "支撑综合结论的证据引用。",
      },
      blocker: {
        type: "string",
        description: "当状态为 blocked 或 failed 时的明确阻塞原因。",
      },
    }, ["status", "summary"]),
  };
}

export function buildRequestUserInputDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: AGENT_USER_INPUT_TOOL_NAMESPACE,
    name: "RequestUserInput",
    description: "请求人工补充信息或确认。请求会进入主消息队列，人工回答统一返回 Coordinator，由 Coordinator 决定后续投递。",
    inputSchema: objectSchema({
      task_id: {
        type: "string",
        description: "可选。当前任务 id；省略时 runtime 会使用当前 active task。Coordinator 可省略。",
      },
      kind: {
        type: "string",
        enum: ["prompt_required", "confirmation_required"],
        description: "输入请求类型。",
      },
      question: {
        type: "string",
        description: "必须向人工提出的明确中文问题。",
      },
      context: {
        type: "string",
        description: "可选。提问背景或需要人工理解的上下文。",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "可选。互斥选项列表。",
      },
    }, ["question"]),
  };
}

export function buildTaskResultDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: AGENT_TASK_RESULT_TOOL_NAMESPACE,
    name: "TaskResult",
    description: "提交当前 agent task 的正式业务结论。Runtime 会把该结论持久化到 task outcome，并通知 Coordinator。",
    inputSchema: objectSchema({
      task_id: {
        type: "string",
        description: "可选。当前任务 id；省略时 runtime 会使用当前 active task。",
      },
      status: {
        type: "string",
        enum: ["complete", "prompt_required", "confirmation_required", "blocked", "insufficient_evidence", "failed"],
        description: "任务业务结论状态。",
      },
      summary: {
        type: "string",
        description: "简洁中文结论摘要。",
      },
      artifact_refs: {
        type: "array",
        items: { type: "string" },
        description: "正式产物引用。完成、证据不足或失败时必须尽量提供。",
      },
      evidence_refs: {
        type: "array",
        items: { type: "string" },
        description: "支撑结论的证据引用。complete 必须提供。",
      },
      blocker: {
        type: "string",
        description: "blocked、failed、insufficient_evidence、prompt_required 或 confirmation_required 时的明确原因。",
      },
      next_step: {
        type: "string",
        description: "建议 Coordinator 采取的下一步。",
      },
    }, ["status", "summary"]),
  };
}

export function parseRequestUserInputDynamicToolCall(tool: string, args: unknown): RequestUserInputToolCall {
  const object = readPlainObject(args);
  return { ...object, tool } as unknown as RequestUserInputToolCall;
}

export function parseTaskResultDynamicToolCall(tool: string, args: unknown): TaskResultToolCall {
  const object = readPlainObject(args);
  return { ...object, tool } as unknown as TaskResultToolCall;
}

export function parseCoordinatorDynamicToolCall(tool: string, args: unknown): CoordinatorAgentToolCall {
  const object = readPlainObject(args);
  return { ...object, tool } as unknown as CoordinatorAgentToolCall;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPlainObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error("Coordinator tool arguments must be an object.");
  }
  return value;
}

function objectSchema(
  properties: Record<string, AgentJsonValue>,
  required: string[],
): AgentJsonValue {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}
