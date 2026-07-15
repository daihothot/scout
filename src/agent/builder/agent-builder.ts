import type { AssetCommit, CodexMount } from "../../asset-store/index.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import { CoordinatorAgent } from "../roles/coordinator-agent.js";
import { ResearcherAgent } from "../roles/researcher-agent.js";
import { ValidatorAgent } from "../roles/validator-agent.js";
import { VerifierAgent } from "../roles/verifier-agent.js";
import type {
  ScoutAgent,
  ScoutAgentOptions,
} from "../core/scout-agent.js";
import { buildAgentDynamicTools } from "../tools/tool-profiles.js";
import type { ScoutAgentRole } from "../thread/types.js";
import { ScoutAgentRoles } from "../thread/types.js";

export type PreparedAgentInputs = Partial<Record<ScoutAgentRole, {
    agentMount: CodexMount;
    assetCommit: AssetCommit;
}>>;

export interface AgentBuilderOptions {
  preparedAgents: PreparedAgentInputs;
}

export class AgentBuilder {
  private readonly options: AgentBuilderOptions;
  private readonly scope: RunScope;

  constructor(options: AgentBuilderOptions) {
    this.options = options;
    this.scope = currentRunScope();
  }

  buildCoordinator(): CoordinatorAgent {
    const agent = new CoordinatorAgent({
      ...this.agentOptionsForRole(ScoutAgentRoles.Coordinator),
      dynamicTools: this.dynamicToolsForRole(ScoutAgentRoles.Coordinator),
    });
    return this.registerAgent(agent) as CoordinatorAgent;
  }

  buildWorker(role: Exclude<ScoutAgentRole, typeof ScoutAgentRoles.Coordinator>): ScoutAgent {
    const common = {
      ...this.agentOptionsForRole(role),
      dynamicTools: this.dynamicToolsForRole(role),
    };
    const agent = this.createWorker(role, common);
    return this.registerAgent(agent);
  }

  dynamicToolsForRole(role: ScoutAgentRole): ReturnType<typeof buildAgentDynamicTools> {
    return [
      ...buildAgentDynamicTools({
        orchestrationTools: role === ScoutAgentRoles.Coordinator,
      }),
      ...this.scope.domain.dynamicToolsForRole(role),
    ];
  }

  private agentOptionsForRole(role: ScoutAgentRole): ScoutAgentOptions {
    const preparedAgent = this.options.preparedAgents[role];
    if (!preparedAgent) {
      throw new Error(`Missing prepared agent runtime for role ${role}.`);
    }
    return {
      agentId: role,
      agentMount: preparedAgent.agentMount,
      assetCommit: preparedAgent.assetCommit,
    };
  }

  private createWorker(
    role: Exclude<ScoutAgentRole, typeof ScoutAgentRoles.Coordinator>,
    options: ScoutAgentOptions,
  ): ScoutAgent {
    if (role === ScoutAgentRoles.Researcher) return new ResearcherAgent(options);
    if (role === ScoutAgentRoles.Validator) return new ValidatorAgent(options);
    return new VerifierAgent(options);
  }

  private registerAgent(agent: ScoutAgent): ScoutAgent {
    return this.scope.agentRegistry.registerAgent(agent);
  }
}
