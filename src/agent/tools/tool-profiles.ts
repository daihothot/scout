import type { AgentDynamicToolSpec } from "./types.js";
import {
  buildAgentToolDynamicTool,
  buildRequestHumanInputDynamicTool,
  buildSendMessageDynamicTool,
} from "./agent-tools.js";

export interface BuildAgentDynamicToolsOptions {
  orchestrationTools?: boolean;
}

export function buildAgentDynamicTools(options: BuildAgentDynamicToolsOptions = {}): AgentDynamicToolSpec[] {
  const tools = [buildRequestHumanInputDynamicTool()];
  if (options.orchestrationTools) {
    tools.unshift(
      buildAgentToolDynamicTool(),
      buildSendMessageDynamicTool(),
    );
  }
  return tools;
}
