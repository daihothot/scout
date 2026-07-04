import type { AgentDynamicToolSpec } from "./types.js";
import {
  buildAssignTaskDynamicTool,
  buildRequestHumanInputDynamicTool,
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
    ];
  }
  return [
    buildRequestHumanInputDynamicTool(),
    buildSubmitTaskDynamicTool(),
  ];
}
