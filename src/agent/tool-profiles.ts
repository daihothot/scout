import {
  buildAgentToolDynamicTool,
  buildRequestUserInputDynamicTool,
  buildSendMessageDynamicTool,
  buildSyntheticOutputDynamicTool,
  buildTaskResultDynamicTool,
  buildTaskStopDynamicTool,
} from "./tools.js";
import type { AgentDynamicToolSpec, ScoutAgentRole } from "./types.js";
import { ScoutAgentRoles } from "./types.js";

export function buildDynamicToolsForRole(role: ScoutAgentRole): AgentDynamicToolSpec[] {
  if (role === ScoutAgentRoles.Coordinator) {
    return [
      buildAgentToolDynamicTool(),
      buildSendMessageDynamicTool(),
      buildTaskStopDynamicTool(),
      buildSyntheticOutputDynamicTool(),
      buildRequestUserInputDynamicTool(),
    ];
  }

  return [
    buildRequestUserInputDynamicTool(),
    buildTaskResultDynamicTool(),
  ];
}
