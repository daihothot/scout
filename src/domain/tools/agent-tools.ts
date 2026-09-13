import type { AgentDynamicToolSpec } from "../../agent/tools/types.js";

/** Unity Pipeline tool shared by Domains that need to control a Unity Editor run. */
export const unityPipelineAgentTool: AgentDynamicToolSpec = {
  guidanceSkill: "tool-unity-pipeline",
  namespace: "rbt_unity_pipeline",
  name: "UnityPipeline",
  description: "通过 Scout Runtime 发现 Unity Editor 运行实例并控制其 Play Mode。",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      operation: {
        type: "string",
        enum: [
          "version",
          "status",
          "list",
          "editor_play",
          "editor_status",
          "editor_stop",
        ],
        description: "Unity Pipeline 操作。",
      },
      timeout_seconds: {
        type: "integer",
        minimum: 1,
        maximum: 120,
        description: "editor_* 操作的超时时间；默认 30 秒。",
      },
    },
    required: ["operation"],
  },
};
