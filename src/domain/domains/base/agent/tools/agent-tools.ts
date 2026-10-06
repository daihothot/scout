import type { AgentDynamicToolSpec } from "../../../../../agent/tools/types.js";

/** Shared execution lifecycle call exposed by the Base Domain. */
export function buildExecutionPlatformDynamicTool(): AgentDynamicToolSpec {
  return {
    guidanceSkill: "tool-execution-platform",
    namespace: "domain_execution",
    name: "ExecutionPlatform",
    description: "通过 Scout Runtime 启动或关闭当前执行平台会话。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["launch", "shutdown"],
          description: "执行平台生命周期操作。",
        },
      },
      required: ["operation"],
    },
  };
}
