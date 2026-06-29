export interface RuntimeExecutionPlan {
  planId: string;
  runId: string;
  status: "draft" | "approved" | "needs_repair" | "rejected";
  steps: RuntimePlanStep[];
}

export interface RuntimePlanStep {
  stepId: string;
  title: string;
  intent: string;
}

export interface PlanReviewResult {
  status: "approved" | "needs_repair" | "rejected";
  validatorNotes: string[];
}
