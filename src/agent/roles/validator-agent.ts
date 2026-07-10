import type { ScoutAgentOptions } from "../core/scout-agent.js";
import { WorkerAgent } from "./worker-agent.js";
import { ScoutAgentPhases, ScoutAgentRoles } from "../thread/types.js";
import { readWorkerRoleInstructions } from "./instructions.js";

export class ValidatorAgent extends WorkerAgent {
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
        model: { ...options.agentMount.agentProfile.model },
        config: {
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
