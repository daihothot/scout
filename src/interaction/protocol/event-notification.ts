import type {
  AgentHumanInputRequestedEventPayload,
  AgentTaskEventPayload,
  AgentTaskEvent,
} from "../../agent/task/task-events.js";
import { AgentEvents } from "../../agent/events/index.js";
import { renderTaskNotificationXml } from "./task-notification.js";
import {
  renderHumanInputRequestNotification,
} from "./human-input.js";
import { escapeXml } from "./xml.js";

export function renderEventNotification(event: AgentTaskEvent): string {
  if (AgentEvents.task.terminal.is(event)) {
    const payload = event.payload as AgentTaskEventPayload;
    return `${renderTaskNotificationXml(payload.task)}\n`;
  }
  if (AgentEvents.task.humanInputRequested.is(event)) {
    const payload = event.payload as AgentHumanInputRequestedEventPayload;
    return `${renderHumanInputRequestNotification({
      task: payload.task,
      request: payload.request,
    })}\n`;
  }
  return [
    `<runtime-event key="${escapeXml(event.key.routeKey)}">`,
    `  <event-id>${escapeXml(event.id)}</event-id>`,
    `  <occurred-at>${escapeXml(event.occurredAt)}</occurred-at>`,
    renderEventPayloadSummary(event),
    "</runtime-event>",
    "",
  ].join("\n");
}

function renderEventPayloadSummary(event: AgentTaskEvent): string {
  const payload = event.payload as Partial<AgentTaskEventPayload>;
  const task = payload.task;
  return [
    task?.taskId ? `  <task-id>${escapeXml(task.taskId)}</task-id>` : undefined,
    task?.agentId ? `  <agent-id>${escapeXml(task.agentId)}</agent-id>` : undefined,
    task?.status ? `  <status>${escapeXml(task.status)}</status>` : undefined,
  ].filter((line): line is string => typeof line === "string").join("\n");
}
