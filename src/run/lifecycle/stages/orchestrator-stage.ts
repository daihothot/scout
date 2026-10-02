import { AgentOrchestrator } from "../../../agent/orchestration/agent-orchestrator.js";
import type { RunStage } from "../run-stage.js";
import { currentRunScope } from "../../run-scope.js";

/** Starts and stops task-to-agent orchestration for the active run. */
export class OrchestratorStage implements RunStage {
  readonly id = "orchestrator";
  private orchestrator?: AgentOrchestrator;

  async start(): Promise<void> {
    const orchestrator = new AgentOrchestrator();
    this.orchestrator = orchestrator;
    const scope = currentRunScope();
    scope.setAgentOrchestrator(orchestrator);
    scope.workflow.registerParticipant(orchestrator);
    orchestrator.start();
  }

  async stop(): Promise<void> {
    if (!this.orchestrator) return;
    this.orchestrator.stop();
    const scope = currentRunScope();
    scope.workflow.unregisterParticipant(this.orchestrator);
    scope.clearAgentOrchestrator(this.orchestrator);
    this.orchestrator = undefined;
  }
}
