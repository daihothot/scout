import { AgentEvents } from "../../events/index.js";
import { AgentStepStatuses } from "../../step/types.js";
import { resolveSynthesisRole } from "../../../core/workflow/index.js";
import { currentRunScope } from "../../../run/run-scope.js";
import { projectAgentWorkflow } from "../projector/agent-workflow-projector.js";

/** Reconciles interrupted Agent work before restoring task and message relationships. */
export class AgentInterruptionRecovery {
  async restore(): Promise<void> {
    const scope = currentRunScope();
    const synthesisRole = resolveSynthesisRole(scope.workflow.graph.snapshot()).name;
    let projection = projectAgentWorkflow(scope.workflow.readEvents(), synthesisRole);
    scope.agentOrchestrator.stepStore.restore(projection.steps);
    for (const turn of projection.turns.filter((candidate) => !candidate.completedAt)) {
      const interruptedAt = new Date().toISOString();
      await scope.eventBus.publishAndWait(AgentEvents.turn.interrupted, {
        invocationId: turn.invocationId, agentId: turn.agentId, role: turn.role,
        taskId: turn.taskId, threadId: turn.threadId,
        reason: "previous_runtime_ended_before_turn_completion", interruptedAt,
      }, { occurredAt: interruptedAt });
    }
    projection = projectAgentWorkflow(scope.workflow.readEvents(), synthesisRole);
    const reason = "previous_runtime_ended_before_step_completion";
    for (const step of projection.steps) {
      if (step.status !== AgentStepStatuses.Running) continue;
      const interruptedAt = new Date().toISOString();
      scope.agentOrchestrator.stepStore.interruptStep(step.stepId, {
        finishedAt: interruptedAt,
        durationMs: Math.max(0, Date.parse(interruptedAt) - Date.parse(step.startedAt)), error: reason,
      });
      if (!step.taskId) continue;
      const task = projection.tasks.find((candidate) => candidate.taskId === step.taskId);
      if (!task) throw new Error(`Interrupted Agent step ${step.stepId} references unknown task ${step.taskId}.`);
      await scope.eventBus.publishAndWait(AgentEvents.task.stepInterrupted,
        { ...task, updatedAt: interruptedAt }, { occurredAt: interruptedAt });
    }
    projection = projectAgentWorkflow(scope.workflow.readEvents(), synthesisRole);
    if (projection.checkpointSeq !== scope.workflow.lastSeq) {
      throw new Error(`Agent projection did not consume journal tail for ${projection.runId}.`);
    }
  }
}
