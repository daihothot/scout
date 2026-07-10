import { ScoutAgentPhases, ScoutAgentRoles } from "../thread/types.js";
import {
  ScoutAgent,
  type ScoutAgentOptions,
} from "../core/scout-agent.js";
import { CoordinatorRunner } from "../runner/coordinator/coordinator-runner.js";
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
        model: { ...options.agentMount.agentProfile.model },
        config: {
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
    const coordinator = this;
    this.runner = new CoordinatorRunner({
      host: {
        get agentId() {
          return coordinator.agentId;
        },
        runTurn: (turnInput) => coordinator.runTurn(turnInput),
        get threadId() {
          return coordinator.threadId;
        },
      },
      eventBus: options.eventBus,
    });
  }
}
