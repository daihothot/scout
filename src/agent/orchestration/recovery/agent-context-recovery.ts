import { WorkerAgent } from "../../../agent/roles/worker-agent.js";
import { CoordinatorAgent } from "../../../agent/roles/coordinator-agent.js";
import { AgentTaskStatuses } from "../../../agent/task/types.js";
import {
  listWorkerRoles,
  resolveSynthesisRole,
} from "../../../core/workflow/index.js";
import { currentRunScope } from "../../../run/run-scope.js";
import { SystemEvents } from "../../../system/events/index.js";
import { buildResumePacket } from "../../context/recovery/resume-packet.js";
import {
  planResumeActions,
  ResumeActionTypes,
  recoverPendingMessages,
} from "./agent-workflow-recovery.js";
import type { AgentWorkflowData } from "../projector/agent-workflow-projector.js";

/**
 * Rehydrates projected messages, worker state, and coordinator state after all
 * runtime services and agents exist. `start` only prepares state; `activate`
 * is called after the run is marked ready so restored work cannot execute
 * against a partially restored scope.
 */
export class AgentContextRecovery {
  private readonly workersToActivate: WorkerAgent[] = [];
  private coordinator?: CoordinatorAgent;
  private activateCoordinator = false;

  /** Loads journal-derived context into interaction stores and agent runners. */
  async restore(projection: AgentWorkflowData): Promise<void> {
    const scope = currentRunScope();
    const graphData = scope.workflow.graph.snapshot();
    const synthesisRole = resolveSynthesisRole(graphData).name;
    const pendingMessages = recoverPendingMessages(projection, synthesisRole);
    const terminal = projection.workflowStatus !== "active";
    scope.agentOrchestrator.toolCallStore.restore(projection.toolCalls);
    scope.agentOrchestrator.stepStore.restore(projection.steps);
    scope.agentOrchestrator.humanInputStore.restore(projection.humanInputRequests);
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

    const workerRoles = listWorkerRoles(graphData).map((role) => role.name);
    for (const role of workerRoles) {
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
        pendingMessages: pendingMessages.filter((message) =>
          message.agentId === worker.agentId
        ),
      });
      if (!task || terminal) continue;
      const resumeActions = planResumeActions({
        projection,
        agentId: worker.agentId,
        role,
        synthesisRole,
      });
      worker.restoreTaskExecution({
        resumeContext: buildResumePacket({
          projection,
          agentId: worker.agentId,
          role,
          synthesisRole,
          assetCommitId: scope.environment.agents[role].assetCommit.assetCommitId,
          resumeActions,
        }),
        resumeImmediately: resumeActions.some((action) =>
          action.type === ResumeActionTypes.ResumeTask
        ),
      });
      this.workersToActivate.push(worker);
    }

    const coordinator = scope.agentRegistry.resolveAgent(synthesisRole);
    if (!(coordinator instanceof CoordinatorAgent)) {
      throw new Error("Restored Coordinator agent is unavailable.");
    }
    this.coordinator = coordinator;
    const coordinatorResumeActions = planResumeActions({
      projection,
      agentId: coordinator.agentId,
      role: synthesisRole,
      synthesisRole,
    });
    this.activateCoordinator = coordinatorResumeActions.length > 0 || (terminal && pendingMessages.some((message) =>
      message.agentId === coordinator.agentId && projection.userMessages.some((user) => user.messageId === message.messageId)));
    this.coordinator.restoreState({
      userInputs: scope.workflow.readEvents().filter((event) => SystemEvents.interaction.userMessageSubmitted.is(event)),
      acceptedMessages: projection.messageDeliveries.filter((message) =>
        message.agentId === coordinator.agentId
      ),
      pendingMessages: pendingMessages.filter((message) =>
        message.agentId === coordinator.agentId
      ),
      resumeContext: terminal ? "" : buildResumePacket({
        projection,
        agentId: coordinator.agentId,
        role: synthesisRole,
        synthesisRole,
        assetCommitId: scope.environment.agents[synthesisRole].assetCommit.assetCommitId,
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
    this.clearWorkflow();
  }

  clearWorkflow(): void {
    this.workersToActivate.length = 0;
    this.coordinator = undefined;
    this.activateCoordinator = false;
  }
}
