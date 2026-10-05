import type { AgentDynamicToolSpec } from "./types.js";
import {
  buildAssignTaskDynamicTool,
  buildRequestHumanInputDynamicTool,
  buildRespondHumanInputDynamicTool,
  buildSendMessageDynamicTool,
  buildSubmitTaskDynamicTool,
  buildSubmitPhaseOutcomeDynamicTool,
  buildStartWorkflowDynamicTool,
  buildResolveArtifactReferenceDynamicTool,
} from "./agent-tools.js";

/** Selects the role-specific subset of built-in agent tools. */
export interface BuildAgentDynamicToolsOptions {
  orchestrationTools?: boolean;
}

/** Builds deterministic tool definitions for Coordinator or Worker threads. */
export function buildAgentDynamicTools(options: BuildAgentDynamicToolsOptions = {}): AgentDynamicToolSpec[] {
  if (options.orchestrationTools) {
    return [
      buildStartWorkflowDynamicTool(),
      buildResolveArtifactReferenceDynamicTool(),
      buildAssignTaskDynamicTool(),
      buildSendMessageDynamicTool(),
      buildRespondHumanInputDynamicTool(),
      buildSubmitPhaseOutcomeDynamicTool(),
    ];
  }
  return [
    buildResolveArtifactReferenceDynamicTool(),
    buildSendMessageDynamicTool(),
    buildRequestHumanInputDynamicTool(),
    buildSubmitTaskDynamicTool(),
  ];
}
