import type { AgentDynamicToolSpec, AgentJsonValue } from "./types.js";
import type { ScoutAgentRole } from "../thread/types.js";
import { ScoutAgentRoles } from "../thread/types.js";
import type { AgentTaskStepToolCall } from "../task/types.js";
import { attachments } from "../context/attachments.js";

export const AGENT_ASSIGN_TASK_TOOL_NAMESPACE = "scout_agent_assigntask";
export const AGENT_SEND_MESSAGE_TOOL_NAMESPACE = "scout_agent_sendmessage";
export const AGENT_SUBMIT_TASK_TOOL_NAMESPACE = "scout_agent_submittask";
export const AGENT_ARCHIVE_TASK_TOOL_NAMESPACE = "scout_agent_archivetask";

export const AGENT_TOOL_NAMESPACES = new Set<string>([
  AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
  AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
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
    description: "向已有 Scout agent 或其当前任务发送 attachment message；Runtime 按 attachment 语义处理对应的接收与状态变化。",
    inputSchema: objectSchema({
      to: {
        type: "string",
        description: "目标 task id 或 agent id。",
      },
      message: {
        type: "string",
        description: "投递给目标 agent 的完整普通 attachment tag block；body 格式遵守对应 attachment 规范。",
      },
    }, ["to", "message"]),
  };
}

export function buildSubmitTaskDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
    name: "SubmitTask",
    description: "仅供 Worker 正式交回当前一轮工作；Runtime 将 Markdown outcome 投递给 Coordinator，并把当前 task 置为 done。",
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

export function readSendMessageAttachment(
  toolCalls: readonly AgentTaskStepToolCall[] | undefined,
  tag: string,
): { body: string } | undefined {
  return (toolCalls ?? []).flatMap((toolCall) => {
    if (
      toolCall.namespace !== AGENT_SEND_MESSAGE_TOOL_NAMESPACE
      || toolCall.tool !== "SendMessage"
      || toolCall.success !== true
    ) {
      return [];
    }
    const call = parseAgentDynamicToolCall(toolCall.tool, toolCall.arguments);
    if (call.tool !== "SendMessage") return [];
    return attachments.readTagBlock(call.message, tag)
      .map(({ body }) => ({ body }));
  })[0];
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
