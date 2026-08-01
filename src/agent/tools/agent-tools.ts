import type { AgentDynamicToolSpec, AgentJsonValue } from "./types.js";
import type { ScoutAgentRole } from "../thread/types.js";
import { ScoutAgentRoles } from "../thread/types.js";

export const AGENT_ASSIGN_TASK_TOOL_NAMESPACE = "scout_agent_assigntask";
export const AGENT_SEND_MESSAGE_TOOL_NAMESPACE = "scout_agent_sendmessage";
export const AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE = "scout_agent_requesthumaninput";
export const AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE = "scout_agent_respondhumaninput";
export const AGENT_SUBMIT_TASK_TOOL_NAMESPACE = "scout_agent_submittask";
export const AGENT_ARCHIVE_TASK_TOOL_NAMESPACE = "scout_agent_archivetask";

export const AGENT_TOOL_NAMESPACES = new Set<string>([
  AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
  AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
  AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
  AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE,
  AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
  AGENT_ARCHIVE_TASK_TOOL_NAMESPACE,
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
  message: string;
}

export interface RequestHumanInputToolCall {
  tool: "RequestHumanInput";
  request: string;
}

export interface RespondHumanInputToolCall {
  tool: "RespondHumanInput";
  task_id: string;
  response: string;
}

export interface SubmitTaskToolCall {
  tool: "SubmitTask";
  outcome: string;
}

export interface ArchiveTaskToolCall {
  tool: "ArchiveTask";
  task_id: string;
}

export type AgentDynamicToolCall =
  | AssignTaskToolCall
  | SendMessageToolCall
  | RequestHumanInputToolCall
  | RespondHumanInputToolCall
  | SubmitTaskToolCall
  | ArchiveTaskToolCall;

export function buildAssignTaskDynamicTool(): AgentDynamicToolSpec {
  return {
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

export function buildSendMessageDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
    name: "SendMessage",
    description: "向已有 Scout agent 或其当前任务发送普通消息。message 只填写需要传达的中文正文，不构造 Runtime 内部通信协议，也不用于人工输入或正式 task 提交。",
    inputSchema: objectSchema({
      to: {
        type: "string",
        description: "目标 task id 或 agent id。",
      },
      message: {
        type: "string",
        description: "投递给目标 agent 的普通中文消息正文。",
      },
    }, ["to", "message"]),
  };
}

export function buildRequestHumanInputDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
    name: "RequestHumanInput",
    description: "仅供 Worker 在当前工作必须等待人工确认时请求输入，必须在本轮结束前调用；普通回复或 SendMessage 不能替代。一次调用应合并当前工作所需的最小问题，同一 step 不得重复调用或再调用 SubmitTask。Runtime 将请求投递给 Coordinator；当前 task 保持 running，当前 step 完成后记录 humanInputRequest。不得用本工具提交 task outcome。",
    inputSchema: objectSchema({
      request: {
        type: "string",
        description: "完整中文请求正文，包含当前 task、已确认内容、缺失或冲突事实、影响、最小问题和期望回答形态。",
      },
    }, ["request"]),
  };
}

export function buildRespondHumanInputDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE,
    name: "RespondHumanInput",
    description: "仅供 Coordinator 把匹配的用户明确回复投递给原 Worker task。Runtime 在目标 Worker 实际消费回复时记录 humanInputResponse；不得加入 Coordinator 自己的领域结论。",
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

export function buildSubmitTaskDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
    name: "SubmitTask",
    description: "仅供 Worker 正式交回当前一轮工作。当前 outcome 已符合适用 handoff contract 时，必须在本轮结束前调用；普通回复、SendMessage、artifact 写入或完成 plan 都不构成提交，漏调会使 task 保持 running。同一 step 不得重复调用或再调用 RequestHumanInput。Runtime 在当前 step 完成后先将当前 task 置为 done，再把 Markdown outcome 投递给 Coordinator。",
    inputSchema: objectSchema({
      outcome: {
        type: "string",
        description: "符合当前 handoff contract 的完整 Markdown outcome 正文。",
      },
    }, ["outcome"]),
  };
}

export function buildArchiveTaskDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: AGENT_ARCHIVE_TASK_TOOL_NAMESPACE,
    name: "ArchiveTask",
    description: "仅供 Coordinator 归档指定 Worker task；归档会释放该 Worker 的当前 runner，但保留 agent thread。",
    inputSchema: objectSchema({
      task_id: {
        type: "string",
        description: "需要归档的准确 task id。",
      },
    }, ["task_id"]),
  };
}

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
      return {
        tool: "SendMessage",
        to: target.trim(),
        message: message.trim(),
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
