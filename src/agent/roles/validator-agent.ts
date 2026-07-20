import type { ScoutAgentOptions } from "../core/scout-agent.js";
import { WorkerAgent } from "./worker-agent.js";
import { ScoutAgentPhases, ScoutAgentRoles } from "../thread/types.js";
import { readWorkerRoleInstructions } from "./instructions.js";
import { currentRunScope } from "../../run/run-scope.js";

export class ValidatorAgent extends WorkerAgent {
  constructor(options: ScoutAgentOptions) {
    const scope = currentRunScope();
    super({
      ...options,
      spec: {
        role: ScoutAgentRoles.Validator,
        phases: [ScoutAgentPhases.Validate],
        cwd: options.agentMount.mountRoot,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        contextBundleId: scope.contextBundle.contextBundleId,
        model: { ...options.agentMount.agentProfile.model },
        config: {
          features: {
            multi_agent: options.agentMount.agentProfile.multiAgent,
          },
          agents: {
            max_threads: options.agentMount.agentProfile.maxThreads,
            max_depth: options.agentMount.agentProfile.maxDepth,
          },
        },
        developerInstructions: readWorkerRoleInstructions(options, ScoutAgentRoles.Validator),
        dynamicTools: options.dynamicTools,
      },
    });
  }
}
