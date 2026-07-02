import { ScoutAgentPhases, ScoutAgentRoles } from "../model/types.js";
import {
  ScoutAgent,
  type ScoutAgentOptions,
} from "../core/scout-agent.js";
import type { CoordinatorRunner } from "../runner/coordinator-runner.js";
import { readRoleAgentInstructions } from "./instructions.js";

export class CoordinatorAgent extends ScoutAgent {
  declare readonly runner: CoordinatorRunner;

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
