import { randomUUID } from "node:crypto";
import { AgentEvents } from "../../../agent/events/index.js";
import { CoordinatorAgent } from "../../../agent/roles/coordinator-agent.js";
import { AgentStepStatuses } from "../../../agent/step/types.js";
import { AgentTaskStatuses } from "../../../agent/task/types.js";
import { currentRunScope } from "../../../run/run-scope.js";
import { SystemEvents } from "../../../system/events/index.js";
import { EventSubscriptionPriorities } from "../../events/index.js";
import type { MachineState } from "../../state/statemachine/index.js";
import type { WorkflowPhaseOutcome } from "../graph-data.js";
import { WorkflowEvents } from "../workflow-events.js";
import type { Workflow, WorkflowAdvanceResult, WorkflowStateRequest } from "../workflow.js";
import { WorkflowState } from "./workflow-state.js";

/** Owns phase progression and the human-input barrier for each advance. */
export class WorkflowRunning implements MachineState<WorkflowState, WorkflowStateRequest> {
  constructor(private readonly workflow: Workflow) {}
  async enter(): Promise<WorkflowState | void> {
    if (this.workflow.graph.completedOutcome !== undefined) return WorkflowState.Closing;
    for (const participant of this.workflow.participants) await participant.run();
  }
  exit(): void {}

  async advance(outcome: WorkflowPhaseOutcome): Promise<WorkflowAdvanceResult> {
    const workflow = this.workflow;
    const scope = currentRunScope();
    const coordinator = scope.agentRegistry.listAgents().find((agent) => agent instanceof CoordinatorAgent);
    let inputArrived = false;
    const unsubscribe = scope.eventBus.subscribe(SystemEvents.interaction.userMessageSubmitted, () => {
      inputArrived = true;
    }, { priority: EventSubscriptionPriorities.Critical });
    try {
      await scope.eventBus.drain(AgentEvents.task.outcomeSubmitted);
      do {
        inputArrived = false;
        await scope.eventBus.drain(SystemEvents.interaction.userMessageSubmitted);
        if (coordinator instanceof CoordinatorAgent) await coordinator.drainInput();
      } while (inputArrived);
    } finally { unsubscribe(); }
    const data = workflow.requireActiveWorkflow();
    if (coordinator instanceof CoordinatorAgent && coordinator.pendingWorkflowInputs().length) {
      return { status: "not_advanced", reason: "pending_user_input" };
    }
    const tasks = scope.taskStore.listTasks();
    const blockers = [
      ...tasks.filter((task) => task.status === AgentTaskStatuses.Queued || task.status === AgentTaskStatuses.Running)
        .map((task) => `Task ${task.taskId} (${task.status})`),
      ...scope.stepStore.list().filter((step) => step.taskId !== undefined && step.status === AgentStepStatuses.Running)
        .map((step) => `Worker Step ${step.stepId} for Task ${step.taskId} is still running`),
      ...scope.agentRegistry.listAgents().flatMap((agent) => {
        const snapshot = agent.snapshot();
        const task = tasks.find((task) => task.taskId === snapshot.activeTask?.taskId);
        return task?.status === AgentTaskStatuses.Done && snapshot.pendingMessageCount > 0
          ? [`Task ${task.taskId} has ${snapshot.pendingMessageCount} pending Worker message(s)`] : [];
      }),
    ];
    if (blockers.length) throw new Error(`Cannot advance Workflow Phase ${workflow.graph.snapshot().currentPhase}: ${blockers.join(", ")}. Finish or stop the outstanding Worker execution first.`);
    const advanced = workflow.graph.previewAdvance(outcome);
    const advancedAt = new Date().toISOString();
    const event = { id: randomUUID(), key: WorkflowEvents.workflow.advanced,
      payload: { ...advanced, outcome, advancedAt }, occurredAt: advancedAt };
    const persisted = workflow.scoutRecordObject.write(event);
    workflow.graph.advance(outcome);
    workflow.updateData(advanced.cycleCompleted
      ? { workflowId: data.workflowId, status: "settling", checkpointSeq: persisted.seq }
      : { ...data, checkpointSeq: persisted.seq });
    scope.eventBus.publish(event.key, event.payload, event);
    await scope.eventBus.drain(WorkflowEvents.workflow.advanced);
    if (advanced.cycleCompleted) {
      try { await workflow.enterState({ state: WorkflowState.Closing }); }
      catch { /* Entry reports the failure and blocks further work; the Graph decision is already committed. */ }
    }
    return { status: "advanced", result: advanced };
  }
}
