import type { AgentTaskState, AgentUserInputRequest } from "../../agent/task/types.js";
import type { RuntimeQueuedCommand } from "../../core/queue/message-queue.js";
import { escapeXml, readXmlTag, readXmlTags } from "./xml.js";

export interface UserInputRequestNotificationInput {
  task?: AgentTaskState;
  request: Omit<AgentUserInputRequest, "taskId"> & {
    taskId?: string;
  };
}

export function renderUserInputRequestNotification(input: UserInputRequestNotificationInput): string {
  return [
    "<user-input-request-notification>",
    `  <request-id>${escapeXml(input.request.requestId)}</request-id>`,
    `  <agent-id>${escapeXml(input.request.agentId)}</agent-id>`,
    input.request.taskId ? `  <task-id>${escapeXml(input.request.taskId)}</task-id>` : undefined,
    `  <kind>${escapeXml(input.request.kind)}</kind>`,
    input.task?.description ? `  <task-description>${escapeXml(input.task.description)}</task-description>` : undefined,
    `  <question>${escapeXml(input.request.question)}</question>`,
    input.request.context ? `  <context>${escapeXml(input.request.context)}</context>` : undefined,
    ...(input.request.options ?? []).map((option) => `  <option>${escapeXml(option)}</option>`),
    "</user-input-request-notification>",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function renderHumanInputPrompt(command: RuntimeQueuedCommand): string {
  const question = readXmlTag(command.payload, "question") ?? "请输入补充信息或确认。";
  const context = readXmlTag(command.payload, "context");
  const options = readXmlTags(command.payload, "option");
  return [
    "Agent 执行过程中需要用户输入。",
    context ? `上下文：${context}` : undefined,
    `问题：${question}`,
    ...options.map((option, index) => `${index + 1}. ${option}`),
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function renderUserInputResponse(command: RuntimeQueuedCommand, response: string): string {
  return [
    "  <user-input-response>",
    `    <command-id>${escapeXml(command.id)}</command-id>`,
    command.sourceTaskId ? `    <task-id>${escapeXml(command.sourceTaskId)}</task-id>` : undefined,
    `    <response>${escapeXml(response)}</response>`,
    "  </user-input-response>",
  ].filter((line): line is string => typeof line === "string").join("\n");
}
