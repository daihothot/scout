import type { AgentStepState } from "../../../agent/step/types.js";
import type { TuiState, TuiTaskPlanStep } from "../tui-store.js";

/** Display projection for a Coordinator step, which has no task container. */
export interface TuiCoordinatorStepDrawerItem {
  stepId: string;
  turnId?: string;
  status: string;
  updatedAt: string;
  planExplanation?: string;
  planSteps: TuiTaskPlanStep[];
}

/** Selects Coordinator steps in execution order for the shared work drawer. */
export function selectCoordinatorSteps(state: TuiState): TuiCoordinatorStepDrawerItem[] {
  return [...(state.steps ?? [])]
    .filter((step) => step.agentId === "coordinator")
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .map(projectCoordinatorStep);
}

function projectCoordinatorStep(step: AgentStepState): TuiCoordinatorStepDrawerItem {
  const plan = readPlan(step.plan);
  return {
    stepId: step.stepId,
    turnId: step.turnId,
    status: step.status,
    updatedAt: step.updatedAt,
    planExplanation: plan.explanation,
    planSteps: plan.steps,
  };
}

function readPlan(plan: unknown): {
  explanation?: string;
  steps: TuiTaskPlanStep[];
} {
  if (!isRecord(plan)) return { steps: [] };
  const explanation = typeof plan.explanation === "string" && plan.explanation.length > 0
    ? plan.explanation
    : undefined;
  const steps = Array.isArray(plan.steps)
    ? plan.steps.flatMap((candidate): TuiTaskPlanStep[] => {
      if (!isRecord(candidate) || typeof candidate.step !== "string") return [];
      return [{
        step: candidate.step,
        status: typeof candidate.status === "string" ? candidate.status : "unknown",
      }];
    })
    : [];
  return { explanation, steps };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
