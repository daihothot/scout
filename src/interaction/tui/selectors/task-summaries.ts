import type {
  TuiState,
  TuiTaskTurn,
} from "../tui-store.js";

/** Drawer projection combining task identity, status, and plan steps. */
export interface TuiTaskDrawerItem {
  taskId: string;
  agentId?: string;
  role?: string;
  status?: string;
  description?: string;
  updatedAt: string;
  turns: TuiTaskTurn[];
}

/** Keeps executing tasks first and historical results in their stable order. */
export function selectTaskSummaries(state: TuiState): TuiTaskDrawerItem[] {
  return state.tasks
    .map((task) => ({
      taskId: task.taskId,
      agentId: task.agentId,
      role: task.role,
      status: task.status,
      description: task.description,
      updatedAt: task.updatedAt,
      turns: task.turns.map((turn) => ({
        ...turn,
        planSteps: turn.planSteps.map((step) => ({ ...step })),
      })),
    }))
    .sort((left, right) =>
      Number(isActiveTaskStatus(right.status)) - Number(isActiveTaskStatus(left.status))
    );
}

/** Identifies statuses that keep a task in the active summary. */
export function isActiveTaskStatus(status: string | undefined): boolean {
  return status === "queued" || status === "running";
}
