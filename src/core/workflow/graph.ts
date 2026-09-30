import {
  createGraphState,
  SynthesisPhase,
  type GraphState,
  type WorkflowPhaseOutcome,
} from "./graph-state.js";
import { Phase } from "./phase.js";
import type { WorkflowProfileAsset } from "../../asset-store/contracts/workflow-profile.js";
import { isDeepStrictEqual } from "node:util";

/** Result of moving the Workflow Graph cursor through one declared edge. */
export interface GraphAdvanceResult {
  readonly state: GraphState;
  readonly previousPhase: string;
  readonly cycleCompleted: boolean;
}

/** Owns the Workflow graph definition and its current cursor. */
export class Graph {
  private state: GraphState;
  private terminalOutcome?: WorkflowPhaseOutcome;

  constructor(asset: WorkflowProfileAsset) {
    const phases = Object.entries(asset.profile.phases.workers);
    const roles = Object.entries(asset.profile.roles).map(([name, role]) => ({
      name,
      phases: name === "coordinator" ? [SynthesisPhase] : [...(role.phases ?? [])],
    }));
    this.state = createGraphState({
      domain: asset.profile.domain,
      workflowProfile: asset.name,
      phases: phases.map(([name, phase]) => ({
        name,
        edges: phase.edges,
        roles: roles.filter((role) => role.phases.includes(name)).map((role) => role.name),
      })),
      roles,
      currentPhase: phases[0]![0],
    });
  }

  snapshot(): GraphState {
    return createGraphState(this.state);
  }

  /** The terminal edge's outcome; a failed Phase with a return edge is not terminal. */
  get completedOutcome(): WorkflowPhaseOutcome | undefined {
    return this.terminalOutcome;
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
    if (advanced.cycleCompleted) this.terminalOutcome = outcome;
    return advanced;
  }

  /** Resets the cursor only when Workflow commits a new Workflow. */
  initializeGraph(): GraphState {
    this.state = this.initialSnapshot();
    this.terminalOutcome = undefined;
    return this.snapshot();
  }

  /** Supplies the same initial cursor to runtime reset and recording baseline. */
  initialSnapshot(): GraphState {
    return createGraphState({ ...this.state, currentPhase: this.state.phases[0]!.name });
  }

  /** Restores the cursor and its terminal conclusion against the Asset's declared edges. */
  restore(state: GraphState, completedOutcome?: WorkflowPhaseOutcome): void {
    if (!this.state.phases.some((phase) => phase.name === state.currentPhase)) {
      throw new Error(`Current Workflow Phase is not declared: ${state.currentPhase}`);
    }
    const expected = createGraphState({ ...this.state, currentPhase: state.currentPhase });
    if (!isDeepStrictEqual(expected, createGraphState(state))) {
      throw new Error("Workflow Graph definition differs from its Asset.");
    }
    if (completedOutcome !== undefined && this.state.phases.find((phase) => phase.name === state.currentPhase)!.edges[completedOutcome] !== null) {
      throw new Error("Restored Workflow Graph outcome does not select a terminal edge.");
    }
    this.state = expected;
    this.terminalOutcome = completedOutcome;
  }

  /** Resolves an edge without changing the durable cursor's in-memory view. */
  previewAdvance(outcome: WorkflowPhaseOutcome): GraphAdvanceResult {
    if (this.terminalOutcome !== undefined) throw new Error("Cannot advance a completed Workflow Graph.");
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
