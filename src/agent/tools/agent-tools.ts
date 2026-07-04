import type { AgentDynamicToolSpec, AgentJsonValue } from "./types.js";
import type { ScoutAgentRole } from "../thread/types.js";
import { ScoutAgentRoles } from "../thread/types.js";

export const AGENT_ASSIGN_TASK_TOOL_NAMESPACE = "scout_agent_assigntask";
export const AGENT_SEND_MESSAGE_TOOL_NAMESPACE = "scout_agent_sendmessage";
export const AGENT_HUMAN_INPUT_TOOL_NAMESPACE = "scout_agent_humaninput";
export const AGENT_SUBMIT_TASK_TOOL_NAMESPACE = "scout_agent_submittask";

export const AGENT_TOOL_NAMESPACES = new Set<string>([
  AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
  AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
  AGENT_HUMAN_INPUT_TOOL_NAMESPACE,
  AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
]);

export interface AssignTaskToolCall {
  tool: "AssignTask";
  agent_id?: string;
  description: string;
  subagent_type: Exclude<ScoutAgentRole, typeof ScoutAgentRoles.Coordinator>;
  prompt: string;
}

export interface SendMessageToolCall {
  tool: "SendMessage";
  to: string;
  type?: "message" | "human_response";
  message: string;
}

export interface RequestHumanInputToolCall {
  tool: "RequestHumanInput";
  task_id?: string;
  kind?: "prompt_required" | "confirmation_required";
  question: string;
  context?: string;
  options?: string[];
}

export interface SubmitTaskToolCall {
  tool: "SubmitTask";
  task_id?: string;
  status: "complete" | "blocked" | "failed";
  summary: string;
}

export type AgentDynamicToolCall =
  | AssignTaskToolCall
  | SendMessageToolCall
  | RequestHumanInputToolCall
  | SubmitTaskToolCall;

export function buildAssignTaskDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
    name: "AssignTask",
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
    namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
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
      type: {
        type: "string",
        enum: ["message", "human_response"],
        description: "消息类型。默认 message；当这是回复 worker 的 RequestHumanInput 时必须显式使用 human_response。",
      },
    }, ["to", "message"]),
  };
}

export function buildRequestHumanInputDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: AGENT_HUMAN_INPUT_TOOL_NAMESPACE,
    name: "RequestHumanInput",
    description: "仅供 worker task 在执行中请求人工补充信息或确认，并中断当前 task turn。Coordinator 不使用此工具；Coordinator 需要询问用户时应直接输出文本。",
    inputSchema: objectSchema({
      task_id: {
        type: "string",
        description: "可选。当前 worker task id；省略时 runtime 会使用当前 worker 的 active task。",
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

export function buildSubmitTaskDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
    name: "SubmitTask",
    description: "仅供 worker 提交当前 task 的正式终态结果。Coordinator 不可见也不使用此工具。",
    inputSchema: objectSchema({
      task_id: {
        type: "string",
        description: "可选。当前 worker task id；省略时 runtime 会使用当前 worker 的 active task。",
      },
      status: {
        type: "string",
        enum: ["complete", "blocked", "failed"],
        description: "当前 task 的终态。stopped 由 Coordinator/runtime 控制，worker 不提交 stopped。",
      },
      summary: {
        type: "string",
        description: "当前 task 的中文结论、阻塞原因或失败原因。",
      },
    }, ["status", "summary"]),
  };
}

export function parseAgentDynamicToolCall(tool: string, args: unknown): AgentDynamicToolCall {
  const object = readPlainObject(args);
  return { ...object, tool } as unknown as AgentDynamicToolCall;
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
