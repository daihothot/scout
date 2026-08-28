import type { ScoutAgentOptions } from "../core/scout-agent.js";
import { WorkerAgent } from "./worker-agent.js";
import {
  ScoutAgentPermissionProfiles,
  ScoutAgentRoles,
} from "../thread/types.js";
import { readAgentInstructions } from "./instructions.js";
import { currentRunScope } from "../../run/run-scope.js";

/** Worker role responsible for validation-phase tasks. */
export class ValidatorAgent extends WorkerAgent {
  constructor(options: ScoutAgentOptions) {
    const scope = currentRunScope();
    super({
      ...options,
      spec: {
        role: ScoutAgentRoles.Validator,
        phases: [options.agentMount.agentProfile.phase],
        cwd: options.agentMount.mountRoot,
        approvalPolicy: "never",
        permissionProfile: ScoutAgentPermissionProfiles.Validator,
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
        developerInstructions: readAgentInstructions(options),
        dynamicTools: options.dynamicTools,
      },
    });
  }
}
