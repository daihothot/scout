import { ScoutAgent, type ScoutAgentOptions } from "../core/scout-agent.js";
import { ScoutAgentPhases, ScoutAgentRoles } from "../model/types.js";
import { readWorkerRoleInstructions } from "./instructions.js";

export class VerifierAgent extends ScoutAgent {
  constructor(options: ScoutAgentOptions) {
    super({
      ...options,
      spec: {
        role: ScoutAgentRoles.Verifier,
        phases: [ScoutAgentPhases.Verify],
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
        developerInstructions: readWorkerRoleInstructions(options, ScoutAgentRoles.Verifier),
        dynamicTools: options.dynamicTools,
      },
    });
  }
}
