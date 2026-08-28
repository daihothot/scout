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
    const agent = new CoordinatorAgent({
      ...this.agentOptionsForRole(role),
      dynamicTools: this.dynamicToolsForRole(role),
    });
    return this.registerAgent(agent) as CoordinatorAgent;
  }

  buildWorker(role: ScoutAgentRole): ScoutAgent {
    const graphState = this.scope.scheduler.snapshot();
    if (role === resolveSynthesisRole(graphState).name) {
      throw new Error("Coordinator must be built through buildCoordinator().");
    }
    const options = {
      ...this.agentOptionsForRole(role),
      dynamicTools: this.dynamicToolsForRole(role),
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

  dynamicToolsForRole(role: ScoutAgentRole): DynamicToolSpec[] {
    const graphState = this.scope.scheduler.snapshot();
    const synthesisRole = resolveSynthesisRole(graphState).name;
    const definitions = [
      ...buildAgentDynamicTools({
        orchestrationTools: role === synthesisRole,
      }),
      ...this.scope.domain.dynamicToolsForRole(role),
    ];
    const mountedSkillNames = new Set(
      this.scope.environment.agents[role].mount.skills.map((skill) => skill.name),
    );
    return definitions.map(({ guidanceSkill, ...tool }) => {
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
