import {
  attachments,
} from "./attachments.js";
import { currentRunScope } from "../../run/run-scope.js";

/** Runtime-owned tag names used to distinguish agent protocol attachments. */
export const AgentContextTags = {
  UseUpdateTools: "use-update-tools",
  Message: "message",
  TaskOutcome: "task-outcome",
  WaitForHumanRequest: "wait-for-human-request",
  HumanResponse: "human-response",
  WorkflowPhase: "workflow_phase",
} as const;

/** Constructs validated, typed attachment blocks for agent turns. */
export const agent = {
  turn: {
    use_update_tools(): string {
      return attachments.addTagBlock(AgentContextTags.UseUpdateTools, [
        "使用内置 update_plan 工具维护当前任务计划。",
        "创建、修改、开始、完成、阻塞、跳过或替换计划步骤时调用 update_plan。",
        "能够用 update_plan 表达计划变化时，不要只在自然语言中描述。",
      ].join("\n"));
    },
    message(message: string): string {
      const reservedTag = Object.values(AgentContextTags).find((tag) =>
        attachments.haveTagBlock(message, tag)
      );
      if (reservedTag) {
        throw new Error(`Plain agent message must not contain Runtime tag: ${reservedTag}`);
      }
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
    workflow_phase(): string {
      const scope = currentRunScope();
      return attachments.addTagBlock(AgentContextTags.WorkflowPhase, [
        `current_domain: ${scope.domain.domainId}`,
        `current_phase: ${scope.scheduler.snapshot().currentPhase}`,
      ].join("\n"));
    },
  },
} as const;
