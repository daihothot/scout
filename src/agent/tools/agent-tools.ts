import type { AgentDynamicToolSpec, AgentJsonValue } from "./types.js";
import type { ScoutAgentRole } from "../thread/types.js";
import { ScoutAgentRoles } from "../thread/types.js";
import type { AgentMessageDeliveryMode } from "../message/types.js";

/**
 * Declares the typed dynamic-tool protocol exposed to Scout agents. This
 * module owns namespace validation and argument parsing; tool handlers own
 * task, message, skill, and human-input side effects.
 */

/** Stable namespaces used to route each agent dynamic tool. */
export const AGENT_ASSIGN_TASK_TOOL_NAMESPACE = "scout_agent_assigntask";
/** Namespace for ordinary agent-to-agent messages. */
export const AGENT_SEND_MESSAGE_TOOL_NAMESPACE = "scout_agent_sendmessage";
/** Namespace for worker requests that require human input. */
export const AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE = "scout_agent_requesthumaninput";
/** Namespace for coordinator responses to human-input requests. */
export const AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE = "scout_agent_respondhumaninput";
/** Namespace for formal worker task handoffs. */
export const AGENT_SUBMIT_TASK_TOOL_NAMESPACE = "scout_agent_submittask";
/** Namespace for coordinator task archival. */
export const AGENT_ARCHIVE_TASK_TOOL_NAMESPACE = "scout_agent_archivetask";

/** Maps protocol tool names to their required app-server namespace. */
export const AGENT_TOOL_NAMESPACE_BY_NAME: Readonly<Record<string, string>> = {
  AssignTask: AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
  SendMessage: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
  RequestHumanInput: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
  RespondHumanInput: AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE,
  SubmitTask: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
  ArchiveTask: AGENT_ARCHIVE_TASK_TOOL_NAMESPACE,
};

/** Set used to reject non-Scout namespaces at the app-server boundary. */
export const AGENT_TOOL_NAMESPACES = new Set<string>(
  Object.values(AGENT_TOOL_NAMESPACE_BY_NAME),
);

/** Throws when a dynamic tool is sent through the wrong namespace. */
export function assertAgentToolNamespace(namespace: string, tool: string): void {
  const expected = AGENT_TOOL_NAMESPACE_BY_NAME[tool];
  if (!expected) throw new Error(`Unsupported agent tool: ${tool}`);
  if (namespace !== expected) {
    throw new Error(`Agent tool ${tool} must use namespace ${expected}, not ${namespace}.`);
  }
}

/** Input contract for coordinator-to-worker task assignment. */
export interface AssignTaskToolCall {
  tool: "AssignTask";
  agent_id?: string;
  description: string;
  subagent_type: Exclude<ScoutAgentRole, typeof ScoutAgentRoles.Coordinator>;
  prompt: string;
}

/** Input contract for ordinary agent-to-agent messaging. */
export interface SendMessageToolCall {
  tool: "SendMessage";
  to: string;
  message: string;
  delivery_mode?: AgentMessageDeliveryMode;
}

/** Input contract for a worker request that pauses on human confirmation. */
export interface RequestHumanInputToolCall {
  tool: "RequestHumanInput";
  request: string;
}

/** Input contract for a coordinator response to a pending human request. */
export interface RespondHumanInputToolCall {
  tool: "RespondHumanInput";
  task_id: string;
  response: string;
}

/** Input contract for a worker's formal task handoff. */
export interface SubmitTaskToolCall {
  tool: "SubmitTask";
  outcome: string;
}

/** Input contract for coordinator task archival. */
export interface ArchiveTaskToolCall {
  tool: "ArchiveTask";
  task_id: string;
}

/** Discriminated union accepted by the dynamic-tool dispatcher. */
export type AgentDynamicToolCall =
  | AssignTaskToolCall
  | SendMessageToolCall
  | RequestHumanInputToolCall
  | RespondHumanInputToolCall
  | SubmitTaskToolCall
  | ArchiveTaskToolCall;

/** Builds the schema for assigning work to an existing worker agent. */
export function buildAssignTaskDynamicTool(): AgentDynamicToolSpec {
  return {
    guidanceSkill: "tool-scout-assign-task",
    namespace: AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
    name: "AssignTask",
    description: "向当前 Run 中已有的 Scout researcher、verifier 或 validator worker agent 分配一个新任务。",
    inputSchema: objectSchema({
      agent_id: {
        type: "string",
        description: "可选。目标 agent id；为空时按 subagent_type 定位当前 Run 中已有的 agent。",
      },
      description: {
        type: "string",
        description: "任务通知中显示的简短任务说明。",
      },
      subagent_type: {
        type: "string",
        enum: [ScoutAgentRoles.Researcher, ScoutAgentRoles.Verifier, ScoutAgentRoles.Validator],
        description: "目标 Scout worker agent 的角色。",
      },
      prompt: {
        type: "string",
        description: "传给目标 agent 的完整中文指令。",
      },
    }, ["description", "subagent_type", "prompt"]),
  };
}

/** Builds the schema for ordinary agent-to-agent messaging. */
export function buildSendMessageDynamicTool(): AgentDynamicToolSpec {
  return {
    guidanceSkill: "tool-scout-send-message",
    namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
    name: "SendMessage",
    description: "向已有 Scout agent 或其当前任务发送普通消息。",
    inputSchema: objectSchema({
      to: {
        type: "string",
        description: "目标 task id 或 agent id。",
      },
      message: {
        type: "string",
        description: "投递给目标 agent 的普通中文消息正文。",
      },
      delivery_mode: {
        type: "string",
        enum: ["steer", "queued"],
        description: "可选。默认 steer：有 active turn 时追加到当前 turn；queued 等当前 turn 结束后再启动新 turn。",
      },
    }, ["to", "message"]),
  };
}

/** Builds the schema for a worker's human-input request. */
export function buildRequestHumanInputDynamicTool(): AgentDynamicToolSpec {
  return {
    guidanceSkill: "tool-scout-request-human-input",
    namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
    name: "RequestHumanInput",
    description: "Worker 在当前任务必须等待人工确认时请求输入。",
    inputSchema: objectSchema({
      request: {
        type: "string",
        description: "完整中文请求正文，包含当前 task、已确认内容、缺失或冲突事实、影响、最小问题和期望回答形态。",
      },
    }, ["request"]),
  };
}

/** Builds the schema for a coordinator's human-input response. */
export function buildRespondHumanInputDynamicTool(): AgentDynamicToolSpec {
  return {
    guidanceSkill: "tool-scout-respond-human-input",
    namespace: AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE,
    name: "RespondHumanInput",
    description: "Coordinator 将用户的明确回复投递给等待中的 Worker task。",
    inputSchema: objectSchema({
      task_id: {
        type: "string",
        description: "原 Worker task 的准确 task id。",
      },
      response: {
        type: "string",
        description: "用户明确确认的中文回复和必要匹配上下文。",
      },
    }, ["task_id", "response"]),
  };
}

/** Builds the schema for formal worker task submission. */
export function buildSubmitTaskDynamicTool(): AgentDynamicToolSpec {
  return {
    guidanceSkill: "tool-scout-submit-task",
    namespace: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
    name: "SubmitTask",
    description: "Worker 将当前任务的正式结果提交给 Coordinator。",
    inputSchema: objectSchema({
      outcome: {
        type: "string",
        description: "符合当前 handoff contract 的完整 Markdown outcome 正文。",
      },
    }, ["outcome"]),
  };
}

/** Builds the schema for coordinator-only task archival. */
export function buildArchiveTaskDynamicTool(): AgentDynamicToolSpec {
  return {
    guidanceSkill: "tool-scout-archive-task",
    namespace: AGENT_ARCHIVE_TASK_TOOL_NAMESPACE,
    name: "ArchiveTask",
    description: "仅供 Coordinator 归档指定 Worker task。",
    inputSchema: objectSchema({
      task_id: {
        type: "string",
        description: "需要归档的准确 task id。",
      },
    }, ["task_id"]),
  };
}

/** Validates and narrows untrusted app-server arguments into a tool call. */
export function parseAgentDynamicToolCall(tool: string, args: unknown): AgentDynamicToolCall {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error(`${tool} arguments must be an object.`);
  }
  const input = args as Record<string, unknown>;

  switch (tool) {
    case "AssignTask": {
      const agentId = input.agent_id;
      if (agentId !== undefined && (typeof agentId !== "string" || agentId.trim().length === 0)) {
        throw new Error("AssignTask agent_id must be a non-empty string when provided.");
      }
      const description = input.description;
      if (typeof description !== "string" || description.trim().length === 0) {
        throw new Error("AssignTask description must be a non-empty string.");
      }
      const subagentType = input.subagent_type;
      if (
        subagentType !== ScoutAgentRoles.Researcher
        && subagentType !== ScoutAgentRoles.Verifier
        && subagentType !== ScoutAgentRoles.Validator
      ) {
        throw new Error("AssignTask subagent_type must be researcher, verifier, or validator.");
      }
      const prompt = input.prompt;
      if (typeof prompt !== "string" || prompt.trim().length === 0) {
        throw new Error("AssignTask prompt must be a non-empty string.");
      }
      return {
        tool: "AssignTask",
        ...(agentId === undefined ? {} : { agent_id: agentId.trim() }),
        description: description.trim(),
        subagent_type: subagentType,
        prompt: prompt.trim(),
      };
    }
    case "SendMessage": {
      const target = input.to;
      if (typeof target !== "string" || target.trim().length === 0) {
        throw new Error("SendMessage to must be a non-empty string.");
      }
      const message = input.message;
      if (typeof message !== "string" || message.trim().length === 0) {
        throw new Error("SendMessage message must be a non-empty string.");
      }
      const deliveryMode = input.delivery_mode;
      if (deliveryMode !== undefined && deliveryMode !== "steer" && deliveryMode !== "queued") {
        throw new Error("SendMessage delivery_mode must be steer or queued.");
      }
      return {
        tool: "SendMessage",
        to: target.trim(),
        message: message.trim(),
        ...(deliveryMode === undefined ? {} : { delivery_mode: deliveryMode }),
      };
    }
    case "RequestHumanInput": {
      const request = input.request;
      if (typeof request !== "string" || request.trim().length === 0) {
        throw new Error("RequestHumanInput request must be a non-empty string.");
      }
      return {
        tool: "RequestHumanInput",
        request: request.trim(),
      };
    }
    case "RespondHumanInput": {
      const taskId = input.task_id;
      if (typeof taskId !== "string" || taskId.trim().length === 0) {
        throw new Error("RespondHumanInput task_id must be a non-empty string.");
      }
      const response = input.response;
      if (typeof response !== "string" || response.trim().length === 0) {
        throw new Error("RespondHumanInput response must be a non-empty string.");
      }
      return {
        tool: "RespondHumanInput",
        task_id: taskId.trim(),
        response: response.trim(),
      };
    }
    case "SubmitTask": {
      const outcome = input.outcome;
      if (typeof outcome !== "string" || outcome.trim().length === 0) {
        throw new Error("SubmitTask outcome must be a non-empty string.");
      }
      return {
        tool: "SubmitTask",
        outcome: outcome.trim(),
      };
    }
    case "ArchiveTask": {
      const taskId = input.task_id;
      if (typeof taskId !== "string" || taskId.trim().length === 0) {
        throw new Error("ArchiveTask task_id must be a non-empty string.");
      }
      return {
        tool: "ArchiveTask",
        task_id: taskId.trim(),
      };
    }
    default:
      throw new Error(`Unsupported agent tool: ${tool}`);
  }
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
