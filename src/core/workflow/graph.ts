import {
  createGraphState,
  type GraphState,
  type WorkflowPhaseOutcome,
} from "./graph-state.js";
import { Phase } from "./phase.js";

/** Result of moving the Workflow Graph cursor through one declared edge. */
export interface GraphAdvanceResult {
  readonly state: GraphState;
  readonly previousPhase: string;
  readonly cycleCompleted: boolean;
}

/** Owns the Workflow graph definition and its current cursor. */
export class Graph {
  private state: GraphState;

  constructor(initialState: GraphState) {
    this.state = createGraphState(initialState);
  }

  snapshot(): GraphState {
    return createGraphState(this.state);
  }

  current(): Phase {
    const phase = this.state.phases.find((candidate) =>
      candidate.name === this.state.currentPhase
    );
    if (!phase) {
      throw new Error(`Current Workflow Phase is not declared: ${this.state.currentPhase}`);
    }
    return new Phase(phase);
  }

  advance(outcome: WorkflowPhaseOutcome): GraphAdvanceResult {
    const advanced = this.previewAdvance(outcome);
    this.state = advanced.state;
    return advanced;
  }

  /** Resets the cursor only when Workflow commits a new Flow. */
  beginFlow(): void {
    this.state = createGraphState({ ...this.state, currentPhase: this.state.phases[0]!.name });
  }

  /** Resolves an edge without changing the durable cursor's in-memory view. */
  previewAdvance(outcome: WorkflowPhaseOutcome): GraphAdvanceResult {
    const previousPhase = this.state.currentPhase;
    const phase = this.state.phases.find((candidate) => candidate.name === previousPhase);
    if (!phase) {
      throw new Error(`Current Workflow Phase is not declared: ${previousPhase}`);
    }
    const target = phase.edges[outcome];
    const cycleCompleted = target === null;
    const state = createGraphState({
      ...this.state,
      currentPhase: target ?? previousPhase,
    });
    return {
      state,
      previousPhase,
      cycleCompleted,
    };
  }
}
