/** Fixed initialization Phase whose Skills are visible to every runtime role. */
export const StartupPhase = "Startup" as const;

/** Fixed Phase used by the Coordinator between Worker Phase results. */
export const SynthesisPhase = "Synthesis" as const;

/** Outcomes selected by Coordinator synthesis for one Worker Phase. */
export type WorkflowPhaseOutcome = "completed" | "error";

/** Outgoing edges declared by one Worker Phase. */
export interface WorkflowPhaseEdges {
  readonly completed: string | null;
  readonly error: string | null;
}

/** Ordered Worker Phase retained by the runtime graph. */
export interface GraphPhase {
  readonly name: string;
  readonly edges: WorkflowPhaseEdges;
  readonly roles: readonly string[];
}

/** Ordered role-to-Phase binding retained by the runtime graph. */
export interface GraphRole {
  readonly name: string;
  readonly phases: readonly string[];
}

/** Current Workflow graph and cursor owned by one Scheduler. */
export interface GraphState {
  readonly workflowProfile: string;
  readonly phases: readonly GraphPhase[];
  readonly roles: readonly GraphRole[];
  readonly currentPhase: string;
}

/** Creates an immutable graph state without introducing a separate state identity. */
export function createGraphState(input: GraphState): GraphState {
  const phases = input.phases.map((phase) => Object.freeze({
    name: phase.name,
    edges: Object.freeze({ ...phase.edges }),
    roles: Object.freeze([...phase.roles]),
  }));
  const roles = input.roles.map((role) => Object.freeze({
    name: role.name,
    phases: Object.freeze([...role.phases]),
  }));
  return Object.freeze({
    workflowProfile: input.workflowProfile,
    phases: Object.freeze(phases),
    roles: Object.freeze(roles),
    currentPhase: input.currentPhase,
  });
}

/** Returns the single role bound to the fixed Synthesis Phase. */
export function resolveSynthesisRole(state: GraphState): GraphRole {
  const roles = state.roles.filter((role) => role.phases.includes(SynthesisPhase));
  if (roles.length !== 1 || !roles[0]) {
    throw new Error(`Workflow requires exactly one Synthesis role; found ${roles.length}.`);
  }
  return roles[0];
}

/** Returns every role not bound to the fixed Synthesis Phase. */
export function listWorkerRoles(state: GraphState): readonly GraphRole[] {
  const synthesisRole = resolveSynthesisRole(state);
  return state.roles.filter((role) => role.name !== synthesisRole.name);
}
