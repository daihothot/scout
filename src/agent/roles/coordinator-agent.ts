import { ScoutAgentPhases, ScoutAgentRoles } from "../thread/types.js";
import {
  ScoutAgent,
  type ScoutAgentOptions,
} from "../core/scout-agent.js";
import { CoordinatorRunner } from "../runner/coordinator/coordinator-runner.js";
import { readRoleAgentInstructions } from "./instructions.js";
import { Result } from "../../core/result.js";
import type { SendAgentMessageInput } from "../task/types.js";
import { currentRunScope } from "../../run/run-scope.js";

export class CoordinatorAgent extends ScoutAgent {
  declare readonly runner: CoordinatorRunner;

  constructor(options: ScoutAgentOptions) {
    const scope = currentRunScope();
    super({
      ...options,
      spec: {
        role: ScoutAgentRoles.Coordinator,
        phases: [ScoutAgentPhases.Coordinate],
        cwd: options.agentMount.mountRoot,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        contextBundleId: scope.contextBundle.contextBundleId,
        model: { ...options.agentMount.agentProfile.model },
        config: {
          web_search: "disabled",
          features: {
            shell_tool: true,
            multi_agent: options.agentMount.agentProfile.multiAgent,
            apps: false,
          },
          agents: {
            max_threads: options.agentMount.agentProfile.maxThreads,
            max_depth: options.agentMount.agentProfile.maxDepth,
          },
        },
        developerInstructions: [
          readRoleAgentInstructions(options, ScoutAgentRoles.Coordinator),
          "当前处于测试阶段。只推进 Research，以及由 Validator 对 Research 相关产出物执行校验；不得指派 Verifier、进入运行验证或把本轮结果描述为完整 Validation 已完成。",
        ].join("\n\n"),
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
    });
  }

  async sendMessage(input: SendAgentMessageInput): Promise<Result<void, string>> {
    if (input.taskId) {
      return Result.err(`Coordinator agent ${this.agentId} does not own task ${input.taskId}.`);
    }
    await this.runner.queueMessage(input);
    return Result.ok(undefined);
  }
}
