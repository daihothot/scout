import { ScoutAgent, type ScoutAgentOptions } from "../core/scout-agent.js";
import { ScoutAgentPhases, ScoutAgentRoles } from "../model/types.js";
import { readWorkerRoleInstructions } from "./instructions.js";

export class ValidatorAgent extends ScoutAgent {
  constructor(options: ScoutAgentOptions) {
    super({
      ...options,
      spec: {
        role: ScoutAgentRoles.Validator,
        phases: [ScoutAgentPhases.Validate],
        cwd: options.agentMount.mountRoot,
        approvalPolicy: "never",
        sandbox: "read-only",
        contextBundleId: options.contextBundle.contextBundleId,
        config: {
          model_reasoning_effort: "minimal",
          features: {
            multi_agent: false,
          },
        },
        developerInstructions: readWorkerRoleInstructions(options, ScoutAgentRoles.Validator),
        dynamicTools: options.dynamicTools,
      },
    });
  }
}
