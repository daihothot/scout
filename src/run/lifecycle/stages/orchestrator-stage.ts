import { AgentOrchestrator } from "../../../agent/orchestration/agent-orchestrator.js";
import type { RunStage } from "../run-stage.js";
import { currentRunScope } from "../../run-scope.js";

/** Installs and releases the Agent runtime owner before and after its consumers. */
export class OrchestratorStage implements RunStage {
  readonly id = "orchestrator";
  private orchestrator?: AgentOrchestrator;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    if (this.orchestrator) throw new Error("AgentOrchestrator startup cleanup is pending; stop the installed owner before retrying.");
    const scope = currentRunScope();
    const roles = scope.workflow.profileAsset.profile.roles;
    const artifactReaders = Object.entries(roles).flatMap(([agentId, role]) => {
      const readers = (role.artifactReaders ?? []).map((reader) => ({
        agentId: reader, phases: roles[reader]!.phases ?? ["Synthesis"],
      }));
      return readers.length ? [{ agentId, readers }] : [];
    });
    const orchestrator = new AgentOrchestrator(artifactReaders);
    scope.setAgentOrchestrator(orchestrator);
    this.orchestrator = orchestrator;
    scope.workflow.registerParticipant(orchestrator);
    orchestrator.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.orchestrator) return;
    const scope = currentRunScope();
    const failures: unknown[] = [];
    try { await scope.workflow.quiesce(); }
    catch (error) {
      // Quiescence reports failures only after all accepted work has settled.
      failures.push(error);
    }
    try {
      this.orchestrator.stop();
      if (scope.workflow.participants.includes(this.orchestrator)) scope.workflow.unregisterParticipant(this.orchestrator);
      scope.clearAgentOrchestrator(this.orchestrator);
      this.orchestrator = undefined;
      this.started = false;
    } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "AgentOrchestrator shutdown failed.");
  }
}
