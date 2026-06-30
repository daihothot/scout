import { ScoutAgent, type ScoutAgentOptions } from "../core/scout-agent.js";
import { ScoutAgentPhases, ScoutAgentRoles } from "../model/types.js";
import { readWorkerRoleInstructions } from "./instructions.js";

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
        dynamicTools: options.dynamicTools,
      },
    });
  }
}
