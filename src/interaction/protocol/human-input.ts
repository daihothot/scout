import type { AgentTaskState, AgentHumanInputRequest, AgentHumanInputResponse } from "../../agent/task/types.js";
import { escapeXml, readXmlTag, readXmlTags } from "./xml.js";

export interface HumanInputRequestNotificationInput {
  task?: AgentTaskState;
  request: Omit<AgentHumanInputRequest, "taskId"> & {
    taskId?: string;
  };
}

export function renderHumanInputRequestNotification(input: HumanInputRequestNotificationInput): string {
  return [
    "<human-input-request-notification>",
    `  <request-id>${escapeXml(input.request.requestId)}</request-id>`,
    `  <agent-id>${escapeXml(input.request.agentId)}</agent-id>`,
    input.request.taskId ? `  <task-id>${escapeXml(input.request.taskId)}</task-id>` : undefined,
    `  <kind>${escapeXml(input.request.kind)}</kind>`,
    input.task?.description ? `  <task-description>${escapeXml(input.task.description)}</task-description>` : undefined,
    `  <question>${escapeXml(input.request.question)}</question>`,
    input.request.context ? `  <context>${escapeXml(input.request.context)}</context>` : undefined,
    ...(input.request.options ?? []).map((option) => `  <option>${escapeXml(option)}</option>`),
    "</human-input-request-notification>",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function renderHumanInputPrompt(input: HumanInputRequestNotificationInput): string {
  const question = input.request.question;
  const context = input.request.context;
  const options = input.request.options ?? [];
  return [
    "Agent 执行过程中需要用户输入。",
    context ? `上下文：${context}` : undefined,
    `问题：${question}`,
    ...options.map((option, index) => `${index + 1}. ${option}`),
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function renderHumanInputResponse(input: {
  eventId?: string;
  response: AgentHumanInputResponse;
}): string {
  return [
    "  <human-input-response>",
    input.eventId ? `    <event-id>${escapeXml(input.eventId)}</event-id>` : undefined,
    `    <request-id>${escapeXml(input.response.requestId)}</request-id>`,
    `    <task-id>${escapeXml(input.response.taskId)}</task-id>`,
    `    <response>${escapeXml(input.response.response)}</response>`,
    "  </human-input-response>",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function readHumanInputRequestIdFromXml(xml: string): string | undefined {
  return readXmlTag(xml, "request-id");
}

export function readHumanInputOptionsFromXml(xml: string): string[] {
  return readXmlTags(xml, "option");
}
