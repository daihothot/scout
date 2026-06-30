import type { AgentDynamicToolSpec } from "../model/types.js";
import {
  buildAgentToolDynamicTool,
  buildRequestHumanInputDynamicTool,
  buildSendMessageDynamicTool,
} from "./system-tools.js";

export interface BuildSystemDynamicToolsOptions {
  orchestrationTools?: boolean;
}

export function buildSystemDynamicTools(options: BuildSystemDynamicToolsOptions = {}): AgentDynamicToolSpec[] {
  const tools = [buildRequestHumanInputDynamicTool()];
  if (options.orchestrationTools) {
    tools.unshift(
      buildAgentToolDynamicTool(),
      buildSendMessageDynamicTool(),
    );
  }
  return tools;
}
