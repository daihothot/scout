import type { AgentTaskState, AgentUserInputRequest } from "../../agent/task/types.js";
import type { ScoutEvent } from "../../core/events/index.js";
import type { SystemInterruptEventPayload } from "../../agent/task/task-events.js";
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

export function renderHumanInputPrompt(event: ScoutEvent<SystemInterruptEventPayload>): string {
  const request = event.payload.request;
  const question = request?.question ?? "请输入补充信息或确认。";
  const context = request?.context;
  const options = request?.options ?? [];
  return [
    "Agent 执行过程中需要用户输入。",
    context ? `上下文：${context}` : undefined,
    `问题：${question}`,
    ...options.map((option, index) => `${index + 1}. ${option}`),
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function renderUserInputResponse(event: ScoutEvent<SystemInterruptEventPayload>, response: string): string {
  const requestId = event.payload.requestId;
  return [
    "  <user-input-response>",
    `    <event-id>${escapeXml(event.id)}</event-id>`,
    requestId ? `    <request-id>${escapeXml(requestId)}</request-id>` : undefined,
    event.payload.taskId ? `    <task-id>${escapeXml(event.payload.taskId)}</task-id>` : undefined,
    `    <response>${escapeXml(response)}</response>`,
    "  </user-input-response>",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function readUserInputRequestId(event: ScoutEvent<SystemInterruptEventPayload>): string | undefined {
  return event.payload.requestId;
}

export function readUserInputRequestIdFromXml(xml: string): string | undefined {
  return readXmlTag(xml, "request-id");
}

export function readUserInputOptionsFromXml(xml: string): string[] {
  return readXmlTags(xml, "option");
}
