import type { AgentDynamicToolSpec } from "./types.js";
import {
  buildArchiveTaskDynamicTool,
  buildAssignTaskDynamicTool,
  buildSendMessageDynamicTool,
  buildSubmitTaskDynamicTool,
} from "./agent-tools.js";

export interface BuildAgentDynamicToolsOptions {
  orchestrationTools?: boolean;
}

export function buildAgentDynamicTools(options: BuildAgentDynamicToolsOptions = {}): AgentDynamicToolSpec[] {
  if (options.orchestrationTools) {
    return [
      buildAssignTaskDynamicTool(),
      buildSendMessageDynamicTool(),
      buildArchiveTaskDynamicTool(),
    ];
  }
  return [
    buildSendMessageDynamicTool(),
    buildSubmitTaskDynamicTool(),
  ];
}
