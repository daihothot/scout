import { ScoutAgentPhases, ScoutAgentRoles } from "../model/types.js";
import {
  ScoutAgent,
  type ScoutAgentOptions,
} from "../core/scout-agent.js";
import { readRoleAgentInstructions } from "./instructions.js";

export class CoordinatorAgent extends ScoutAgent {
  constructor(options: ScoutAgentOptions) {
    super({
      ...options,
      spec: {
        role: ScoutAgentRoles.Coordinator,
        phases: [ScoutAgentPhases.Coordinate],
        cwd: options.agentMount.mountRoot,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        contextBundleId: options.contextBundle.contextBundleId,
        config: {
          model_reasoning_effort: "minimal",
          web_search: "disabled",
          features: {
            shell_tool: false,
            multi_agent: false,
            apps: false,
          },
        },
        developerInstructions: readRoleAgentInstructions(options, ScoutAgentRoles.Coordinator),
        dynamicTools: options.dynamicTools,
      },
    });
  }
}
