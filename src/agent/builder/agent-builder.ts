import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import { CoordinatorAgent } from "../roles/coordinator-agent.js";
import { WorkerAgent } from "../roles/worker-agent.js";
import { readWorkerAgentInstructions } from "../roles/instructions.js";
import type {
  ScoutAgent,
  ScoutAgentOptions,
} from "../core/scout-agent.js";
import { buildAgentDynamicTools } from "../tools/tool-profiles.js";
import type { DynamicToolSpec } from "../../agent-server/codex/app-server-client.js";
import {
  scoutAgentPermissionProfile,
  type ScoutAgentRole,
} from "../thread/types.js";
import {
  resolveSynthesisRole,
} from "../../core/workflow/index.js";

/** Builds Workflow-declared agents from prepared mounts and domain tools. */
export class AgentBuilder {
  private readonly scope: RunScope = currentRunScope();

  buildCoordinator(): CoordinatorAgent {
    const role = resolveSynthesisRole(this.scope.scheduler.snapshot()).name;
    const options = this.agentOptionsForRole(role);
    const agent = new CoordinatorAgent({
      ...options,
      dynamicTools: this.dynamicToolsForRole(
        role,
        buildAgentDynamicTools({ orchestrationTools: true }),
      ),
    });
    return this.registerAgent(agent) as CoordinatorAgent;
  }

  buildWorker(role: ScoutAgentRole): ScoutAgent {
    const graphState = this.scope.scheduler.snapshot();
    if (role === resolveSynthesisRole(graphState).name) {
      throw new Error("Coordinator must be built through buildCoordinator().");
    }
    const agentOptions = this.agentOptionsForRole(role);
    const phaseDynamicTools = agentOptions.agentMount.agentProfile.phases
      .flatMap((phase) => this.scope.domain.dynamicToolsForPhase(phase));
    const options = {
      ...agentOptions,
      dynamicTools: this.dynamicToolsForRole(
        role,
        [
          ...buildAgentDynamicTools({ orchestrationTools: false }),
          ...phaseDynamicTools,
        ],
      ),
    };
    const profile = options.agentMount.agentProfile;
    const agent = new WorkerAgent({
      ...options,
      spec: {
        role,
        phases: [...profile.phases],
        cwd: options.agentMount.mountRoot,
        approvalPolicy: "never",
        permissionProfile: scoutAgentPermissionProfile(role),
        contextBundleId: this.scope.contextBundle.contextBundleId,
        model: { ...profile.model },
        config: {
          features: {
            multi_agent: profile.multiAgent,
          },
          agents: {
            max_threads: profile.maxThreads,
            max_depth: profile.maxDepth,
          },
        },
        developerInstructions: readWorkerAgentInstructions(options),
        dynamicTools: options.dynamicTools,
      },
    });
    return this.registerAgent(agent);
  }

  private dynamicToolsForRole(
    role: ScoutAgentRole,
    definitions: ReturnType<typeof buildAgentDynamicTools>,
  ): DynamicToolSpec[] {
    const uniqueDefinitions = new Map<string, typeof definitions[number]>();
    for (const definition of definitions) {
      const identity = `${definition.namespace ?? ""}\0${definition.name}`;
      const existing = uniqueDefinitions.get(identity);
      if (existing && JSON.stringify(existing) !== JSON.stringify(definition)) {
        throw new Error(`Dynamic tool ${definition.name} has conflicting Phase definitions.`);
      }
      uniqueDefinitions.set(identity, definition);
    }
    const mountedSkillNames = new Set(
      this.scope.environment.agents[role].mount.skills.map((skill) => skill.name),
    );
    return [...uniqueDefinitions.values()].map(({ guidanceSkill, ...tool }) => {
      if (!mountedSkillNames.has(guidanceSkill)) {
        throw new Error(
          `Dynamic tool ${tool.name} requires unavailable guidance Skill ${guidanceSkill} for ${role}.`,
        );
      }
      return tool;
    });
  }

  private agentOptionsForRole(role: ScoutAgentRole): ScoutAgentOptions {
    const preparedAgent = this.scope.environment.agents[role];
    if (!preparedAgent) {
      throw new Error(`Missing prepared agent runtime for role ${role}.`);
    }
    return {
      agentId: role,
      agentMount: preparedAgent.mount,
      assetCommit: preparedAgent.assetCommit,
    };
  }

  private registerAgent(agent: ScoutAgent): ScoutAgent {
    return this.scope.agentRegistry.registerAgent(agent);
  }
}
