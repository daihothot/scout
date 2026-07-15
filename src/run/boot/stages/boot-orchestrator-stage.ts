import { AgentOrchestrator } from "../../../agent/orchestration/agent-orchestrator.js";
import { currentRunScope } from "../../run-scope.js";
import type { BootStage } from "../boot-stage.js";

export class BootOrchestratorStage implements BootStage {
  readonly id = "orchestrator";
  private orchestrator?: AgentOrchestrator;

  async start(): Promise<void> {
    const orchestrator = new AgentOrchestrator({
      eventBus: currentRunScope().eventBus,
    });
    orchestrator.start();
    this.orchestrator = orchestrator;
  }

  async stop(): Promise<void> {
    this.orchestrator?.stop();
    this.orchestrator = undefined;
  }
}
