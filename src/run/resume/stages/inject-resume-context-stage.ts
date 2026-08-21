import { WorkerAgent } from "../../../agent/roles/worker-agent.js";
import { CoordinatorAgent } from "../../../agent/roles/coordinator-agent.js";
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

/**
 * Rehydrates projected messages, worker state, and coordinator state after all
 * runtime services and agents exist. `start` only prepares state; `activate`
 * is called after the run is marked ready so restored work cannot execute
 * against a partially restored scope.
 */
export class InjectResumeContextStage implements RunStage {
  readonly id = "inject_resume_context";
  private readonly workersToActivate: WorkerAgent[] = [];
  private coordinator?: CoordinatorAgent;
  private activateCoordinator = false;

  /** Loads journal-derived context into interaction stores and agent runners. */
  async start(): Promise<void> {
    const scope = currentRunScope();
    const projection = projectRun(scope.journal.readAll());
    scope.toolCallStore.restore(projection.toolCalls);
    scope.stepStore.restore(projection.steps);
    scope.humanInputStore.restore(projection.humanInputRequests);
    for (const step of projection.steps) {
      await scope.interactionPort.restoreStepSnapshot?.(step);
    }
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
      const worker = scope.agentRegistry.resolveAgent(role);
      if (!(worker instanceof WorkerAgent)) {
        throw new Error(`Restored agent ${role} is not a Worker agent.`);
      }
      worker.restoreMessages({
        acceptedMessages: projection.messageDeliveries.filter((message) =>
          message.agentId === worker.agentId
        ),
        pendingMessages: projection.pendingMessages.filter((message) =>
          message.agentId === worker.agentId
        ),
      });
      if (!task) continue;
      const resumeActions = planResumeActions({
        projection,
        agentId: worker.agentId,
        role,
      });
      worker.restoreTaskExecution({
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
    if (!(coordinator instanceof CoordinatorAgent)) {
      throw new Error("Restored Coordinator agent is unavailable.");
    }
    this.coordinator = coordinator;
    const coordinatorResumeActions = planResumeActions({
      projection,
      agentId: coordinator.agentId,
      role: ScoutAgentRoles.Coordinator,
    });
    this.activateCoordinator = coordinatorResumeActions.length > 0;
    this.coordinator.restoreState({
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

  /** Starts only the restored workers and coordinator that have resumable work. */
  activate(): void {
    for (const worker of this.workersToActivate) worker.activateRestoredTask();
    if (this.activateCoordinator) {
      this.coordinator?.activateRestoredState();
    }
  }
}
