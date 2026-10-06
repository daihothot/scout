import type { AgentDynamicToolSpec } from "../../../../../agent/tools/types.js";

/** Searches for an Execution Pack and returns its stable Artifact reference. */
export function buildSearchExecutionPackDynamicTool(): AgentDynamicToolSpec {
  return {
    guidanceSkill: "tool-rbt-search-execution-pack",
    namespace: "rbt_artifact",
    name: "SearchExecutionPack",
    description: "搜索相同 BDD、SDK 版本下执行与审查均成功的历史 Execute Pack，返回稳定的 Artifact 引用。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        bdd_id: { type: "string", minLength: 1, description: "当前任务的 canonical BDD ID。" },
        target_version: { type: "string", minLength: 1, description: "当前目标 SDK 版本。" },
      },
      required: ["bdd_id", "target_version"],
    },
  };
}

export function buildJarvisBehaviorDynamicTool(): AgentDynamicToolSpec {
  return {
    guidanceSkill: "tool-rbt-behavior",
    namespace: "rbt_behavior",
    name: "JarvisBehavior",
    description: "执行一个 RBT execute-file，或发送一条当前阶段允许的 Behavioral 查询命令。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        execute_file: {
          type: "object",
          additionalProperties: false,
          properties: {
            workflowId: { type: "string" },
            agentId: { type: "string" },
            internalSymbols: { type: "array", items: { type: "string" } },
          },
          required: ["workflowId", "agentId", "internalSymbols"],
          description: "待执行的 execute-file.json 的 ScoutArtifactReference。",
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
}

/** RBT Domain-internal WebSocket tool definition; not exposed to the Agent yet. */
export function buildJarvisWebSocketDynamicTool(): AgentDynamicToolSpec {
  return {
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
}
