import type {
  AgentTaskEventPayload,
  AgentTaskSystemEvent,
  SystemInterruptEventPayload,
} from "../../agent/task/task-events.js";
import { SystemEvents } from "../../core/events/index.js";
import { renderTaskNotificationXml } from "./task-notification.js";
import { renderUserInputRequestNotification } from "./user-input.js";
import { escapeXml, indentXmlText } from "./xml.js";

export function renderCoordinatorEvents(events: AgentTaskSystemEvent[]): string {
  return [
    "<runtime-events>",
    ...events.map((event) => [
      `  <event id="${escapeXml(event.id)}" key="${escapeXml(event.key.routeKey)}">`,
      indentXmlText(renderEventNotification(event).trimEnd(), "    "),
      "  </event>",
    ].join("\n")),
    "</runtime-events>",
  ].join("\n");
}

export function renderEventNotification(event: AgentTaskSystemEvent): string {
  if (SystemEvents.task.terminal.is(event)) {
    const payload = event.payload as AgentTaskEventPayload;
    return `${renderTaskNotificationXml(payload.task)}\n`;
  }
  if (SystemEvents.interrupt.raised.is(event)) {
    const payload = event.payload as SystemInterruptEventPayload;
    if (payload.interruptKind === "human_input" && payload.request) {
      return `${renderUserInputRequestNotification({
        task: payload.task,
        request: payload.request,
      })}\n`;
    }
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

function renderEventPayloadSummary(event: AgentTaskSystemEvent): string {
  const payload = event.payload as Partial<AgentTaskEventPayload & SystemInterruptEventPayload>;
  const task = payload.task;
  return [
    payload.interruptKind ? `  <interrupt-kind>${escapeXml(payload.interruptKind)}</interrupt-kind>` : undefined,
    payload.taskId || task?.taskId ? `  <task-id>${escapeXml(payload.taskId ?? task?.taskId ?? "")}</task-id>` : undefined,
    payload.agentId || task?.agentId ? `  <agent-id>${escapeXml(payload.agentId ?? task?.agentId ?? "")}</agent-id>` : undefined,
    payload.status || task?.status ? `  <status>${escapeXml(payload.status ?? task?.status ?? "")}</status>` : undefined,
  ].filter((line): line is string => typeof line === "string").join("\n");
}
