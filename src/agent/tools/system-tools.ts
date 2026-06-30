import type { AgentDynamicToolSpec, AgentJsonValue, ScoutAgentRole } from "../model/types.js";
import { ScoutAgentRoles } from "../model/types.js";

export const SYSTEM_TOOL_NAMESPACE = "scout";

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

export interface RequestHumanInputToolCall {
  tool: "RequestHumanInput";
  task_id?: string;
  kind?: "prompt_required" | "confirmation_required";
  question: string;
  context?: string;
  options?: string[];
}

export type SystemToolCall =
  | AgentToolCall
  | SendMessageToolCall
  | RequestHumanInputToolCall;

export function buildAgentToolDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: SYSTEM_TOOL_NAMESPACE,
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
    namespace: SYSTEM_TOOL_NAMESPACE,
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

export function buildRequestHumanInputDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: SYSTEM_TOOL_NAMESPACE,
    name: "RequestHumanInput",
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

export function parseSystemDynamicToolCall(tool: string, args: unknown): SystemToolCall {
  const object = readPlainObject(args);
  return { ...object, tool } as unknown as SystemToolCall;
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
