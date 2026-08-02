import type { AgentDynamicToolSpec } from "./types.js";
import {
  buildArchiveTaskDynamicTool,
  buildAssignTaskDynamicTool,
  buildFindSkillsDynamicTool,
  buildReadSkillResourceDynamicTool,
  buildRequestHumanInputDynamicTool,
  buildRespondHumanInputDynamicTool,
  buildSendMessageDynamicTool,
  buildSubmitTaskDynamicTool,
} from "./agent-tools.js";

export interface BuildAgentDynamicToolsOptions {
  orchestrationTools?: boolean;
}

export function buildAgentDynamicTools(options: BuildAgentDynamicToolsOptions = {}): AgentDynamicToolSpec[] {
  const skillTools = [
    buildFindSkillsDynamicTool(),
    buildReadSkillResourceDynamicTool(),
  ];
  if (options.orchestrationTools) {
    return [
      ...skillTools,
      buildAssignTaskDynamicTool(),
      buildSendMessageDynamicTool(),
      buildRespondHumanInputDynamicTool(),
      buildArchiveTaskDynamicTool(),
    ];
  }
  return [
    ...skillTools,
    buildSendMessageDynamicTool(),
    buildRequestHumanInputDynamicTool(),
    buildSubmitTaskDynamicTool(),
  ];
}
