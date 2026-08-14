import type { AgentDynamicToolSpec, AgentJsonValue } from "./types.js";
import type { ScoutAgentRole } from "../thread/types.js";
import { ScoutAgentRoles } from "../thread/types.js";

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
/** Namespace for phase-scoped skill navigation. */
export const AGENT_FIND_SKILLS_TOOL_NAMESPACE = "scout_agent_findskills";
/** Namespace for reading a selected skill resource. */
export const AGENT_READ_SKILL_RESOURCE_TOOL_NAMESPACE = "scout_agent_readskillresource";

/** Maps protocol tool names to their required app-server namespace. */
export const AGENT_TOOL_NAMESPACE_BY_NAME: Readonly<Record<string, string>> = {
  AssignTask: AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
  SendMessage: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
  RequestHumanInput: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
  RespondHumanInput: AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE,
  SubmitTask: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
  ArchiveTask: AGENT_ARCHIVE_TASK_TOOL_NAMESPACE,
  FindSkills: AGENT_FIND_SKILLS_TOOL_NAMESPACE,
  ReadSkillResource: AGENT_READ_SKILL_RESOURCE_TOOL_NAMESPACE,
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

/** Input contract for phase-scoped skill family navigation. */
export interface FindSkillsToolCall {
  tool: "FindSkills";
  family?: string[];
  detail?: "names" | "metadata";
}

/** Input contract for reading a resource from a selected skill. */
export interface ReadSkillResourceToolCall {
  tool: "ReadSkillResource";
  selection_id: string;
  skill_id: string;
  resource: string;
}

/** Discriminated union accepted by the dynamic-tool dispatcher. */
export type AgentDynamicToolCall =
  | AssignTaskToolCall
  | SendMessageToolCall
  | RequestHumanInputToolCall
  | RespondHumanInputToolCall
  | SubmitTaskToolCall
  | ArchiveTaskToolCall
  | FindSkillsToolCall
  | ReadSkillResourceToolCall;

/** Builds the schema for phase-scoped skill navigation. */
export function buildFindSkillsDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: AGENT_FIND_SKILLS_TOOL_NAMESPACE,
    name: "FindSkills",
    description: [
      "在 Runtime 为当前 Agent phase 建立的 Skill 观察范围内，按 family 发现或精确选择可路由的 Scout Skill。",
      "未知入口时先省略 family 取得一级 family，再把上次 family 前缀与一个返回的直接子节点原样组成 family，每次只前进一步。",
      "已知完整 canonical leaf 时可直接提交完整 family；Runtime 只接受当前 phase mount 中精确存在的 leaf，并为本 turn 重新签发 selection。",
      "如果返回 reason=family_navigation_reset，说明请求路径没有当前 turn 的连续 discovery 状态；丢弃 requestedFamily，从 facets 返回的根节点重新开始。",
      "中间节点只返回下一层 family；到达叶节点后才返回 selectionId 和 dependency-first loadOrder。",
      "detail 默认为 names；metadata 额外返回当前 family 范围的安全 Skill frontmatter，但不包含正文或授予资源读取权。",
      "无 family 的服务 Skill 不参与导航，只能由入口 Skill 的 requiredSkills 自动带入 selection；tags 只作为结果特征，不参与筛选。",
      "逐级发现受同一 agent/thread/turn/phase/asset commit 的导航连续性约束；精确选择也会按当前 phase mount 和 asset commit 重新授权。",
      "叶节点同时返回该 selection 的 required/optional resource catalog 和完整性状态；同一 scope 的任一 selection required 未全部读取时不能开始新的 Skill discovery 或 SubmitTask。",
    ].join("\n"),
    inputSchema: objectSchema({
      family: {
        type: "array",
        minItems: 1,
        items: {
          type: "string",
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
        },
        description: "按顺序组成的 family 路径。未知入口时首次省略，后续每次准确追加一个返回的直接子节点；已知完整 canonical leaf 时可直接提交完整路径。",
      },
      detail: {
        type: "string",
        enum: ["names", "metadata"],
        description: "候选投影。默认 names 只返回紧凑名称；metadata 额外返回当前 family 范围内的安全 Skill frontmatter，不包含正文。",
      },
    }, []),
  };
}

/** Builds the schema for reading a resource from a current-turn Skill selection. */
export function buildReadSkillResourceDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: AGENT_READ_SKILL_RESOURCE_TOOL_NAMESPACE,
    name: "ReadSkillResource",
    description: "读取本 task/thread/turn 中任一 FindSkills selection 已声明的 Skill 文本资源。新 selection 不会撤销同一 scope 的既有 selection；每个 Skill 的 SKILL.md 必须等待其 required Skill 的 SKILL.md，无依赖关系的 Skill 可以并行。某个 Skill 的 SKILL.md 读完后，它声明的 supplementary resources 可以并行读取；全部 required 内容读取成功后该 selection 才 ready，optional 按 description 或正文适用条件读取。selection 不能跨 agent、task、thread、turn、phase 或 asset commit 使用，禁止读取未声明资源、绝对路径和路径穿越。",
    inputSchema: objectSchema({
      selection_id: {
        type: "string",
        minLength: 1,
        description: "FindSkills 精筛成功后返回的 selectionId。",
      },
      skill_id: {
        type: "string",
        pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
        description: "selection loadOrder 中的准确 Skill id。",
      },
      resource: {
        type: "string",
        minLength: 1,
        maxLength: 512,
        description: "Skill 根目录内的相对文本资源路径，例如 SKILL.md 或 templates/template-index.md。",
      },
    }, ["selection_id", "skill_id", "resource"]),
  };
}

/** Builds the schema for assigning work to an existing worker agent. */
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

/** Builds the schema for ordinary agent-to-agent messaging. */
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

/** Builds the schema for a worker's human-input request. */
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

/** Builds the schema for a coordinator's human-input response. */
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

/** Builds the schema for formal worker task submission. */
export function buildSubmitTaskDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
    name: "SubmitTask",
    description: "仅供 Worker 正式交回当前一轮工作。普通 turn 必须先用 FindSkills 签发当前 turn 的 Skill selection，并读取全部 required resources；只有不存在未完成 discovery、当前 task/thread/turn 的全部 selection 都与当前 phase/asset commit 一致且已 ready 时才能提交。Runtime 协议修正 turn 只能精确复用触发修正的上一 turn 的全部 ready selections，不得重新发现或选择 Skill。当前 outcome 符合适用 handoff contract 时，必须在本轮结束前调用。普通回复、SendMessage、artifact 写入或完成 plan 都不构成提交，漏调会使 task 保持 running。同一 step 不得重复调用或再调用 RequestHumanInput。Runtime 接受 outcome 时会把当前 Worker 的 ${SCOUT_ARTIFACT_ROOT} 引用绑定为带 owner 的 run-scoped ref；在当前 step 完成后先将 task 置为 done，再把 Markdown outcome 投递给 Coordinator。",
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
    case "FindSkills": {
      if ("phase" in input || "domain" in input || "tags" in input) {
        throw new Error(
          "FindSkills no longer accepts phase, domain, or tags; Runtime supplies phase and returns family paths.",
        );
      }
      const detail = input.detail;
      if (detail !== undefined && detail !== "names" && detail !== "metadata") {
        throw new Error("FindSkills detail must be names or metadata when provided.");
      }
      const family = input.family;
      if (family !== undefined) {
        if (!Array.isArray(family) || family.length === 0) {
          throw new Error("FindSkills family must be a non-empty ordered token path when provided.");
        }
        return {
          tool: "FindSkills",
          family: family.map((token) => validateSkillToken(token, "FindSkills family token")),
          ...(detail === undefined ? {} : { detail }),
        };
      }
      return {
        tool: "FindSkills",
        ...(detail === undefined ? {} : { detail }),
      };
    }
    case "ReadSkillResource": {
      const selectionId = requireNonEmptyString(input.selection_id, "ReadSkillResource selection_id");
      const skillId = validateSkillToken(input.skill_id, "ReadSkillResource skill_id");
      const resource = requireNonEmptyString(input.resource, "ReadSkillResource resource");
      return {
        tool: "ReadSkillResource",
        selection_id: selectionId,
        skill_id: skillId,
        resource,
      };
    }
    default:
      throw new Error(`Unsupported agent tool: ${tool}`);
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function validateSkillToken(value: unknown, label: string): string {
  const token = requireNonEmptyString(value, label).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(token)) {
    throw new Error(`${label} must be a lowercase kebab-case token.`);
  }
  return token;
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
