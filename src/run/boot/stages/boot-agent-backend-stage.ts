import { AgentBackend } from "../../../agent/backend/agent-backend.js";
import type { WorkerAgent } from "../../../agent/roles/worker-agent.js";
import { ScoutAgentRoles } from "../../../agent/thread/types.js";
import { currentRunScope } from "../../run-scope.js";
import type { BootStage } from "../boot-stage.js";

export class BootAgentBackendStage implements BootStage {
  readonly id = "agent_backend";
  private backend?: AgentBackend;

  async start(): Promise<void> {
    const scope = currentRunScope();
    const backend = new AgentBackend({
      agentProvider: {
        resolveWorker(input): WorkerAgent {
          const agent = scope.agentRegistry.resolveAgent(input.role);
          if (agent.role === ScoutAgentRoles.Coordinator) {
            throw new Error("Coordinator cannot be resolved as a worker.");
          }
          return agent as WorkerAgent;
        },
      },
    });
    backend.start();
    this.backend = backend;
  }

  async stop(): Promise<void> {
    this.backend?.stop();
    this.backend = undefined;
  }
}
