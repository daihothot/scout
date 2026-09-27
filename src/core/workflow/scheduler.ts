import { AgentStepStatuses } from "../../agent/step/types.js";
import { AgentTaskStatuses } from "../../agent/task/types.js";
import { currentRunScope } from "../../run/run-scope.js";
import type { GraphState, WorkflowPhaseOutcome } from "./graph-state.js";
import type { Graph } from "./graph.js";
import { Phase } from "./phase.js";
import type { Workflow } from "./workflow.js";

/** Result of applying one Coordinator-owned Phase outcome. */
export interface SchedulerAdvanceResult {
  readonly state: GraphState;
  readonly cycleCompleted: boolean;
}

/** Schedules work against the Workflow-owned Graph and publishes its transitions. */
export class Scheduler {
  private workflow?: Workflow;

  constructor(private readonly graph: Graph) {}

  start(): void {
    if (this.workflow) return;
    this.workflow = currentRunScope().workflow;
  }

  stop(): void {
    this.workflow = undefined;
  }

  /** Returns an immutable snapshot of the current graph state. */
  snapshot(): GraphState {
    return this.graph.snapshot();
  }

  /** Publishes the initial graph so recovery can restore the runtime cursor. */
  initialize(): GraphState {
    return this.requireWorkflow().initializeGraph();
  }

  /** Returns the current Phase that owns Worker selection. */
  current(): Phase {
    return this.graph.current();
  }

  /** Advances only after the currently accepted Worker execution has ended. */
  advance(outcome: WorkflowPhaseOutcome): SchedulerAdvanceResult {
    const workflow = this.requireWorkflow();
    const scope = currentRunScope();
    const tasks = scope.taskStore.listTasks();
    const blockers = [
      ...tasks
        .filter((task) => task.status === AgentTaskStatuses.Queued || task.status === AgentTaskStatuses.Running)
        .map((task) => `Task ${task.taskId} (${task.status})`),
      ...scope.stepStore.list()
        .filter((step) => step.taskId !== undefined && step.status === AgentStepStatuses.Running)
        .map((step) => `Worker Step ${step.stepId} for Task ${step.taskId} is still running`),
      ...scope.agentRegistry.listAgents().flatMap((agent) => {
        const snapshot = agent.snapshot();
        const task = tasks.find((task) => task.taskId === snapshot.activeTask?.taskId);
        return task?.status === AgentTaskStatuses.Done && snapshot.pendingMessageCount > 0
          ? [`Task ${task.taskId} has ${snapshot.pendingMessageCount} pending Worker message(s)`]
          : [];
      }),
    ];
    if (blockers.length > 0) {
      throw new Error(`Cannot advance Workflow Phase ${this.graph.snapshot().currentPhase}: ${blockers.join(", ")}. Finish or stop the outstanding Worker execution first.`);
    }
    return workflow.advanceGraph(outcome);
  }

  private requireWorkflow(): Workflow {
    if (!this.workflow) throw new Error("Workflow Scheduler is not started.");
    return this.workflow;
  }
}
