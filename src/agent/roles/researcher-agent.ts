import { ScoutAgent, type ScoutAgentOptions } from "../scout-agent.js";
import { buildDynamicToolsForRole } from "../tool-profiles.js";
import { ScoutAgentPhases, ScoutAgentRoles } from "../types.js";
import { readWorkerRoleInstructions } from "../helper.js";

export class ResearcherAgent extends ScoutAgent {
  constructor(options: ScoutAgentOptions) {
    super({
      ...options,
      spec: {
        role: ScoutAgentRoles.Researcher,
        phases: [ScoutAgentPhases.Research],
        cwd: options.agentMount.mountRoot,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        contextBundleId: options.contextBundle.contextBundleId,
        config: {
          model_reasoning_effort: "minimal",
          features: {
            multi_agent: false,
          },
        },
        developerInstructions: readWorkerRoleInstructions(options, ScoutAgentRoles.Researcher),
        dynamicTools: buildDynamicToolsForRole(ScoutAgentRoles.Researcher),
      },
    });
  }
}
