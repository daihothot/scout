import {
  attachments,
} from "./attachments.js";

export const AgentContextTags = {
  UseUpdateTools: "use-update-tools",
  Message: "message",
  TaskOutcome: "task-outcome",
  WaitForHumanRequest: "wait-for-human-request",
  HumanResponse: "human-response",
} as const;

export const agent = {
  turn: {
    use_update_tools(): string {
      return attachments.addTagBlock(AgentContextTags.UseUpdateTools, [
        "Use the built-in update_plan tool to keep the task plan current.",
        "Call update_plan when you create, change, start, complete, block, skip, or supersede plan steps.",
        "Do not describe plan changes only in text when update_plan can represent them.",
      ].join("\n"));
    },
    message(message: string): string {
      return attachments.addTagBlock(AgentContextTags.Message, message);
    },
    wait_for_human_request(request: string): string {
      return attachments.addTagBlock(AgentContextTags.WaitForHumanRequest, request);
    },
    task_outcome(outcome: string): string {
      return attachments.addTagBlock(AgentContextTags.TaskOutcome, outcome);
    },
    human_response(response: string): string {
      return attachments.addTagBlock(AgentContextTags.HumanResponse, response);
    },
  },
} as const;
