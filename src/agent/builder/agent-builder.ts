import type { AssetCommit, CodexMount } from "../../asset-store/index.js";
import type { ScoutDomain } from "../../domain/index.js";
import { CoordinatorAgent } from "../roles/coordinator-agent.js";
import { ResearcherAgent } from "../roles/researcher-agent.js";
import { ValidatorAgent } from "../roles/validator-agent.js";
import { VerifierAgent } from "../roles/verifier-agent.js";
import type {
  ScoutAgent,
  ScoutAgentOptions,
} from "../core/scout-agent.js";
import type { AgentThreadLifecycle } from "../lifecycle/agent-thread-lifecycle.js";
import type { AgentRegistry } from "../lifecycle/agent-registry.js";
import { buildSystemDynamicTools } from "../tools/tool-profiles.js";
import type { ScoutAgentRole } from "../model/types.js";
import { ScoutAgentRoles } from "../model/types.js";
import type { AgentTaskStore } from "../task/agent-task-store.js";

export interface AgentBuilderRuntime {
  repoRoot: ScoutAgentOptions["repoRoot"];
  appServer: ScoutAgentOptions["appServer"];
  contextBundle: ScoutAgentOptions["contextBundle"];
  logger: ScoutAgentOptions["logger"];
  eventBus: ScoutAgentOptions["eventBus"];
}

export type PreparedAgentInputs = Partial<Record<ScoutAgentRole, {
    agentMount: CodexMount;
    assetCommit: AssetCommit;
}>>;

export interface AgentBuilderOptions {
  domain: ScoutDomain;
  registry: AgentRegistry;
  lifecycle: AgentThreadLifecycle;
  taskStore: AgentTaskStore;
  runtime: AgentBuilderRuntime;
  preparedAgents: PreparedAgentInputs;
}

export class AgentBuilder {
  private readonly options: AgentBuilderOptions;

  constructor(options: AgentBuilderOptions) {
    this.options = options;
  }

  buildCoordinator(): CoordinatorAgent {
    const agent = new CoordinatorAgent({
      ...this.agentOptionsForRole(ScoutAgentRoles.Coordinator),
      dynamicTools: this.dynamicToolsForRole(ScoutAgentRoles.Coordinator),
    });
    return this.registerAgent(agent) as CoordinatorAgent;
  }

  buildWorker(input: {
    role: Exclude<ScoutAgentRole, typeof ScoutAgentRoles.Coordinator>;
    agentId?: string;
  }): ScoutAgent {
    const common = {
      ...this.agentOptionsForRole(input.role, input.agentId),
      dynamicTools: this.dynamicToolsForRole(input.role),
    };
    const agent = this.createWorker(input.role, common);
    return this.registerAgent(agent);
  }

  getOrCreateWorker(input: {
    role: Exclude<ScoutAgentRole, typeof ScoutAgentRoles.Coordinator>;
    agentId?: string;
  }): ScoutAgent {
    const existing = this.options.registry.findAgent(input.agentId ?? input.role);
    if (existing) return existing;
    return this.buildWorker(input);
  }

  dynamicToolsForRole(role: ScoutAgentRole): ReturnType<typeof buildSystemDynamicTools> {
    return [
      ...buildSystemDynamicTools({
        orchestrationTools: role === ScoutAgentRoles.Coordinator,
      }),
      ...this.options.domain.dynamicToolsForRole(role),
    ];
  }

  private agentOptionsForRole(role: ScoutAgentRole, agentId?: string): ScoutAgentOptions {
    const preparedAgent = this.options.preparedAgents[role];
    if (!preparedAgent) {
      throw new Error(`Missing prepared agent runtime for role ${role}.`);
    }
    return {
      agentId: agentId ?? role,
      repoRoot: this.options.runtime.repoRoot,
      appServer: this.options.runtime.appServer,
      contextBundle: this.options.runtime.contextBundle,
      agentMount: preparedAgent.agentMount,
      assetCommit: preparedAgent.assetCommit,
      logger: this.options.runtime.logger,
      taskStore: this.options.taskStore,
      eventBus: this.options.runtime.eventBus,
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
    agent.setThreadPreflightRunner((target) => this.options.lifecycle.startWithPreflight(target));
    return this.options.registry.registerAgent(agent);
  }
}
