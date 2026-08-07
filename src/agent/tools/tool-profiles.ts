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

/** Selects the role-specific subset of built-in agent tools. */
export interface BuildAgentDynamicToolsOptions {
  orchestrationTools?: boolean;
}

/** Builds deterministic tool definitions for Coordinator or Worker threads. */
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
