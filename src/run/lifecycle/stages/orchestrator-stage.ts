import { AgentOrchestrator } from "../../../agent/orchestration/agent-orchestrator.js";
import type { RunStage } from "../run-stage.js";

export class OrchestratorStage implements RunStage {
  readonly id = "orchestrator";
  private orchestrator?: AgentOrchestrator;

  async start(): Promise<void> {
    const orchestrator = new AgentOrchestrator();
    orchestrator.start();
    this.orchestrator = orchestrator;
  }

  async stop(): Promise<void> {
    this.orchestrator?.stop();
    this.orchestrator = undefined;
  }
}
