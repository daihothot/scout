import type { AgentDynamicToolSpec } from "./types.js";
import {
  buildAssignTaskDynamicTool,
  buildRequestHumanInputDynamicTool,
  buildRespondHumanInputDynamicTool,
  buildSendMessageDynamicTool,
  buildSubmitTaskDynamicTool,
  buildSubmitPhaseOutcomeDynamicTool,
} from "./agent-tools.js";

/** Selects the role-specific subset of built-in agent tools. */
export interface BuildAgentDynamicToolsOptions {
  orchestrationTools?: boolean;
}

/** Builds deterministic tool definitions for Coordinator or Worker threads. */
export function buildAgentDynamicTools(options: BuildAgentDynamicToolsOptions = {}): AgentDynamicToolSpec[] {
  if (options.orchestrationTools) {
    return [
      buildAssignTaskDynamicTool(),
      buildSendMessageDynamicTool(),
      buildRespondHumanInputDynamicTool(),
      buildSubmitPhaseOutcomeDynamicTool(),
    ];
  }
  return [
    buildSendMessageDynamicTool(),
    buildRequestHumanInputDynamicTool(),
    buildSubmitTaskDynamicTool(),
  ];
}
