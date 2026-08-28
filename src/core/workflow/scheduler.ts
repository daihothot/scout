import type { EventBus } from "../events/index.js";
import { createGraphState, type GraphState } from "./graph-state.js";
import type { WorkflowPhaseOutcome } from "./graph-state.js";
import { Phase } from "./phase.js";
import { WorkflowEvents } from "./workflow-events.js";

/** Result of applying one Coordinator-owned Phase outcome. */
export interface SchedulerAdvanceResult {
  readonly state: GraphState;
  readonly cycleCompleted: boolean;
}

/** Owns the current Workflow cursor and applies declared Phase edges. */
export class Scheduler {
  private state: GraphState;

  constructor(
    initialState: GraphState,
    private readonly eventBus: EventBus,
  ) {
    this.state = createGraphState(initialState);
  }

  /** Returns an immutable snapshot of the current graph state. */
  snapshot(): GraphState {
    return createGraphState(this.state);
  }

  /** Publishes the initial graph so recovery can restore the runtime cursor. */
  initialize(): GraphState {
    const initializedAt = new Date().toISOString();
    const state = this.snapshot();
    this.eventBus.publish(WorkflowEvents.workflow.initialized, {
      state,
      initializedAt,
    }, { occurredAt: initializedAt });
    return state;
  }

  /** Returns the current Phase that owns Worker selection. */
  current(): Phase {
    const phase = this.state.phases.find((candidate) =>
      candidate.name === this.state.currentPhase
    );
    if (!phase) {
      throw new Error(`Current Workflow Phase is not declared: ${this.state.currentPhase}`);
    }
    return new Phase(phase);
  }

  /** Moves the cursor through the edge selected by Coordinator synthesis. */
  advance(outcome: WorkflowPhaseOutcome): SchedulerAdvanceResult {
    const currentPhase = this.state.currentPhase;
    const phase = this.state.phases.find((candidate) => candidate.name === currentPhase);
    if (!phase) {
      throw new Error(`Current Workflow Phase is not declared: ${currentPhase}`);
    }
    const target = phase.edges[outcome];
    const cycleCompleted = target === null;
    const nextPhase = target ?? this.state.phases[0]!.name;
    this.state = createGraphState({
      ...this.state,
      currentPhase: nextPhase,
    });
    const advancedAt = new Date().toISOString();
    const state = this.snapshot();
    this.eventBus.publish(WorkflowEvents.workflow.advanced, {
      state,
      previousPhase: currentPhase,
      outcome,
      cycleCompleted,
      advancedAt,
    }, { occurredAt: advancedAt });
    return { state, cycleCompleted };
  }
}
