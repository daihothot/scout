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
  WorkflowContext: "workflow_context",
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
    human_response(input: {
      requestId: string;
      taskId: string;
      messageId: string;
      response: string;
    }): string {
      return attachments.addTagBlock(AgentContextTags.HumanResponse, [
        `requestId: ${input.requestId}`,
        `taskId: ${input.taskId}`,
        `messageId: ${input.messageId}`,
        "response:",
        input.response,
      ].join("\n"));
    },
    workflow_phase(): string {
      const scope = currentRunScope();
      const workflowState = scope.workflow.snapshot();
      return attachments.addTagBlock(AgentContextTags.WorkflowPhase, [
        `current_domain: ${scope.workflow.graph.snapshot().domain}`,
        `current_phase: ${workflowState ? scope.workflow.graph.snapshot().currentPhase : "none"}`,
        `workflow_status: ${workflowState?.status ?? "empty"}`,
        ...(workflowState?.status === "settling"
          ? ["Graph 已终止，Runtime 正在完成 Workflow 事务；不得新建 Task、再次推进 Graph 或代替 Runtime 收尾。"]
          : []),
        ...(!workflowState ? ["无活动 Workflow。仅交流或查看历史；明确的新执行需求由 Coordinator 调用 StartWorkflow，接受后结束本次 response。"] : []),
      ].join("\n"));
    },
  },
} as const;
