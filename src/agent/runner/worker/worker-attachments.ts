import type { AgentAttachment } from "../../context/attachments.js";
import type { AgentTaskState } from "../../task/types.js";

export interface WorkerTaskTickInput {
  taskId: string;
  status: AgentTaskState["status"];
  description: string;
  latestStepId?: string;
}

export const worker = {
  turn: {
    task_tick(input: WorkerTaskTickInput): string {
      return JSON.stringify({
        type: "task_tick",
        task: {
          taskId: input.taskId,
          status: input.status,
          description: input.description,
          latestStepId: input.latestStepId,
        },
        instruction: "continue_current_task",
      });
    },
    pending_message(message: string): string {
      return [
        "<pending-message origin=\"coordinator\">",
        message,
        "</pending-message>",
      ].join("\n");
    },
  },
} as const;

export function getWorkerPendingMessageAttachments(input: {
  messages: string[];
}): AgentAttachment[] {
  return input.messages.map((message) => ({
    prompt: worker.turn.pending_message(message),
    origin: { kind: "coordinator" },
    isMeta: true,
  }));
}
