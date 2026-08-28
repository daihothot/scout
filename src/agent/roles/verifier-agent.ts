import type { ScoutAgentOptions } from "../core/scout-agent.js";
import { WorkerAgent } from "./worker-agent.js";
import {
  ScoutAgentPermissionProfiles,
  ScoutAgentRoles,
} from "../thread/types.js";
import { readAgentInstructions } from "./instructions.js";
import { currentRunScope } from "../../run/run-scope.js";

/** Worker role responsible for verification-phase tasks. */
export class VerifierAgent extends WorkerAgent {
  constructor(options: ScoutAgentOptions) {
    const scope = currentRunScope();
    super({
      ...options,
      spec: {
        role: ScoutAgentRoles.Verifier,
        phases: [options.agentMount.agentProfile.phase],
        cwd: options.agentMount.mountRoot,
        approvalPolicy: "never",
        permissionProfile: ScoutAgentPermissionProfiles.Verifier,
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
