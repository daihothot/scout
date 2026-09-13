import type { DynamicToolCallResponse } from "../../../../agent-server/types.js";
import type { ScoutAgentPhase } from "../../../../agent/thread/types.js";
import type { AgentDynamicToolSpec } from "../../../../agent/tools/types.js";
import { unityPipelineAgentTool } from "../../../tools/index.js";
import type { ScoutDomainDynamicToolCall } from "../../../types.js";

export const RbtAgentDynamicToolImplementations = {
  UnityPipeline: "unity-pipeline",
  JarvisWebSocket: "jarvis-websocket",
  JarvisBehaviorExecute: "jarvis-behavior-execute",
  JarvisBehaviorReview: "jarvis-behavior-review",
} as const;

export type RbtAgentDynamicToolImplementation =
  typeof RbtAgentDynamicToolImplementations[keyof typeof RbtAgentDynamicToolImplementations];

/** Runtime behavior required by one registered RBT Agent dynamic tool. */
export interface RbtAgentDynamicTool {
  execute(call: ScoutDomainDynamicToolCall): Promise<DynamicToolCallResponse>;
  stop?(): Promise<void> | void;
}

export interface RbtAgentDynamicToolRegistration {
  phase: ScoutAgentPhase;
  implementation: RbtAgentDynamicToolImplementation;
  definition: AgentDynamicToolSpec;
}

const jarvisBehaviorTool: AgentDynamicToolSpec = {
  guidanceSkill: "tool-rbt-behavior",
  namespace: "rbt_behavior",
  name: "JarvisBehavior",
  description: "执行一个 RBT execute-file，或发送一条当前阶段允许的 Behavioral 查询命令。",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      execute_file: {
        type: "string",
        minLength: 1,
        description: "待执行的 execute-file.json 路径。",
      },
      command: {
        type: "string",
        enum: [
          "behavior.registry.nodes",
          "behavior.node.variants",
          "behavior.evidence.sources",
          "behavior.trigger.commands",
          "behavior.campaign.query",
          "behavior.evidence.query",
        ],
        description: "一条只读 Behavioral 查询命令。",
      },
      payload: {
        type: "object",
        description: "查询命令的 Runtime payload。",
      },
    },
    oneOf: [
      { required: ["execute_file"] },
      { required: ["command", "payload"] },
    ],
  },
};

/** RBT Domain-internal WebSocket tool definition; not exposed to the Agent yet. */
export const jarvisWebSocketAgentTool: AgentDynamicToolSpec = {
  guidanceSkill: "tool-rbt-websocket",
  namespace: "rbt_websocket",
  name: "JarvisWebSocket",
  description: "管理 RBT Domain 使用的 Jarvis Behavioral WebSocket session。",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      operation: {
        type: "string",
        enum: ["connect", "disconnect"],
        description: "连接或断开一个内部 WebSocket session。",
      },
      session_id: { type: "string", minLength: 1 },
      endpoint: { type: "string", minLength: 1 },
    },
    oneOf: [
      { required: ["operation", "session_id", "endpoint"] },
      { required: ["operation", "session_id"] },
    ],
  },
};

/** Single source of truth for RBT Phase tool visibility and runtime construction. */
export const rbtAgentDynamicToolRegistrations: readonly RbtAgentDynamicToolRegistration[] = [
  {
    phase: "execute",
    implementation: RbtAgentDynamicToolImplementations.UnityPipeline,
    definition: unityPipelineAgentTool,
  },
  {
    phase: "execute",
    implementation: RbtAgentDynamicToolImplementations.JarvisBehaviorExecute,
    definition: jarvisBehaviorTool,
  },
  {
    phase: "review",
    implementation: RbtAgentDynamicToolImplementations.JarvisBehaviorReview,
    definition: jarvisBehaviorTool,
  },
];

/** Returns the dynamic-tool definitions registered for one Workflow Phase. */
export function rbtAgentDynamicToolsForPhase(phase: ScoutAgentPhase): AgentDynamicToolSpec[] {
  return rbtAgentDynamicToolRegistrations
    .filter((registration) => registration.phase === phase)
    .map((registration) => registration.definition);
}
