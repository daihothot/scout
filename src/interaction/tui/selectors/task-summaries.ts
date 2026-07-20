import type {
  TuiState,
  TuiTaskPlanStep,
} from "../tui-store.js";

export interface TuiTaskDrawerItem {
  taskId: string;
  agentId?: string;
  role?: string;
  status?: string;
  description?: string;
  updatedAt: string;
  planSteps: TuiTaskPlanStep[];
}

export function selectTaskSummaries(state: TuiState): TuiTaskDrawerItem[] {
  return state.tasks
    .map((task) => ({
      taskId: task.taskId,
      agentId: task.agentId,
      role: task.role,
      status: task.status,
      description: task.description,
      updatedAt: task.updatedAt,
      planSteps: task.planSteps.map((step) => ({ ...step })),
    }))
    .sort((left, right) =>
      Number(left.status === "archived") - Number(right.status === "archived")
    );
}

export function isActiveTaskStatus(status: string | undefined): boolean {
  return status === "queued" || status === "running";
}
