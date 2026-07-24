import { WorkerAgent } from "../../../agent/roles/worker-agent.js";
import { AgentTaskStatuses } from "../../../agent/task/types.js";
import { ScoutAgentRoles } from "../../../agent/thread/types.js";
import type { RunStage } from "../../lifecycle/index.js";
import { currentRunScope } from "../../run-scope.js";
import { buildResumePacket } from "../packet/index.js";
import {
  planResumeActions,
  projectRun,
  ResumeActionTypes,
} from "../projection/index.js";

export class InjectResumeContextStage implements RunStage {
  readonly id = "inject_resume_context";
  private readonly workersToActivate: WorkerAgent[] = [];
  private coordinatorRunner?: import("../../../agent/runner/coordinator/coordinator-runner.js").CoordinatorRunner;
  private activateCoordinator = false;

  async start(): Promise<void> {
    const scope = currentRunScope();
    const projection = projectRun(scope.journal.readAll());
    scope.humanInputStore.restore(projection.humanInputRequests);
    const transcript = [
      ...projection.userMessages.map((message) => ({
        kind: "user" as const,
        seq: message.seq,
        id: message.messageId,
        text: message.text,
        createdAt: message.acceptedAt,
      })),
      ...projection.coordinatorMessages.map((message) => ({
        kind: "coordinator" as const,
        seq: message.seq,
        id: message.messageId,
        text: message.text,
        createdAt: message.createdAt,
      })),
    ].sort((left, right) => left.seq - right.seq);
    for (const message of transcript) {
      if (message.kind === "user") {
        await scope.interactionPort.restoreUserMessage(message);
      } else {
        await scope.interactionPort.receiveAgentMessage(message);
      }
    }

    for (const role of [
      ScoutAgentRoles.Researcher,
      ScoutAgentRoles.Verifier,
      ScoutAgentRoles.Validator,
    ] as const) {
      const task = projection.tasks.find((candidate) =>
        candidate.agentId === role
        && (
          candidate.status === AgentTaskStatuses.Queued
          || candidate.status === AgentTaskStatuses.Running
          || candidate.status === AgentTaskStatuses.Done
        )
      );
      if (!task) continue;
      const worker = scope.agentRegistry.resolveAgent(role);
      if (!(worker instanceof WorkerAgent)) {
        throw new Error(`Restored agent ${role} is not a Worker agent.`);
      }
      const resumeActions = planResumeActions({
        projection,
        agentId: worker.agentId,
        role,
      });
      worker.restoreState({
        acceptedMessages: projection.messageDeliveries.filter((message) =>
          message.agentId === worker.agentId && message.taskId === task.taskId
        ),
        pendingMessages: projection.pendingMessages.filter((message) =>
          message.agentId === worker.agentId && message.taskId === task.taskId
        ),
        resumeContext: buildResumePacket({
          projection,
          agentId: worker.agentId,
          role,
          assetCommitId: scope.environment.agents[role].assetCommit.assetCommitId,
          resumeActions,
        }),
        resumeImmediately: resumeActions.some((action) =>
          action.type === ResumeActionTypes.ResumeTask
        ),
      });
      this.workersToActivate.push(worker);
    }

    const coordinator = scope.agentRegistry.resolveAgent(ScoutAgentRoles.Coordinator);
    const runner = coordinator.runner;
    if (!runner || runner.runnerKind !== "coordinator") {
      throw new Error("Restored Coordinator runner is unavailable.");
    }
    this.coordinatorRunner = runner as import("../../../agent/runner/coordinator/coordinator-runner.js").CoordinatorRunner;
    const coordinatorResumeActions = planResumeActions({
      projection,
      agentId: coordinator.agentId,
      role: ScoutAgentRoles.Coordinator,
    });
    this.activateCoordinator = coordinatorResumeActions.length > 0;
    this.coordinatorRunner.restoreState({
      acceptedMessages: projection.messageDeliveries.filter((message) =>
        message.agentId === coordinator.agentId
      ),
      pendingMessages: projection.pendingMessages.filter((message) =>
        message.agentId === coordinator.agentId
      ),
      resumeContext: buildResumePacket({
        projection,
        agentId: coordinator.agentId,
        role: ScoutAgentRoles.Coordinator,
        assetCommitId: scope.environment.agents[ScoutAgentRoles.Coordinator].assetCommit.assetCommitId,
        resumeActions: coordinatorResumeActions,
      }),
    });
  }

  activate(): void {
    for (const worker of this.workersToActivate) worker.activateRestoredTask();
    if (this.activateCoordinator) {
      this.coordinatorRunner?.activateRestoredState();
    }
  }
}
