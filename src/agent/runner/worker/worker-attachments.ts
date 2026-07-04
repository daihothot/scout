import { attachments } from "../../context/attachments.js";
import type { AgentTaskState } from "../../task/types.js";

export interface WorkerTaskTickInput {
  taskId: string;
  status: AgentTaskState["status"];
  description: string;
  latestStepId?: string;
}

export const WorkerContextTags = {
  TaskTick: "task-tick",
} as const;

export const worker = {
  turn: {
    task_tick(input: WorkerTaskTickInput): string {
      return attachments.addTagBlock(WorkerContextTags.TaskTick, JSON.stringify({
        type: "task_tick",
        task: {
          taskId: input.taskId,
          status: input.status,
          description: input.description,
          latestStepId: input.latestStepId,
        },
        instruction: "continue_current_task",
      }));
    },
  },
} as const;
