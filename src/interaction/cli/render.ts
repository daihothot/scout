import type { AgentTaskSystemEvent } from "../../agent/task/task-events.js";
import type { RuntimeDisclosureEvent, RuntimeProgressEvent } from "../port.js";
import { renderEventNotification as renderProtocolEventNotification } from "../protocol/index.js";

export function renderDisclosure(event: RuntimeDisclosureEvent): string {
  const structured = renderStructuredDisclosureData(event.data);
  const data = event.data === undefined ? "" : `\n${structured ?? JSON.stringify(event.data, null, 2)}`;
  return `[${event.level}] ${event.source}: ${event.message}${data}\n`;
}

export function renderEventNotification(event: AgentTaskSystemEvent): string {
  return renderProtocolEventNotification(event);
}

export function renderProgress(event: RuntimeProgressEvent): string {
  const parts = [
    `[progress] ${event.source}`,
    event.seq !== undefined ? `seq=${event.seq}` : undefined,
    event.agentId ? `agent=${event.agentId}` : undefined,
    event.taskId ? `task=${event.taskId}` : undefined,
    `type=${event.type}`,
    `status=${event.status}`,
    `label=${event.label}`,
    event.detail ? `detail=${event.detail}` : undefined,
  ].filter(Boolean);
  return `${parts.join(" ")}\n`;
}

export function renderGoal(goal: unknown): string {
  const object = readObject(goal);
  if (!object) return JSON.stringify(goal, null, 2);
  const lines = [
    "Goal:",
    `  objective: ${readString(object, "objective") ?? ""}`,
    `  status: ${readString(object, "status") ?? "unknown"}`,
  ];
  const tokensUsed = readNumber(object, "tokensUsed");
  const tokenBudget = readNumber(object, "tokenBudget");
  if (tokensUsed !== undefined || tokenBudget !== undefined) {
    lines.push(`  tokens: ${tokensUsed ?? 0}${tokenBudget !== undefined ? `/${tokenBudget}` : ""}`);
  }
  return lines.join("\n");
}

export function renderPlan(plan: unknown): string {
  const object = readObject(plan);
  if (!object) return JSON.stringify(plan, null, 2);
  const steps = readArray(object.steps);
  const lines = ["Plan:"];
  const explanation = readString(object, "explanation");
  if (explanation) lines.push(`  ${explanation}`);
  for (const step of steps) {
    const stepObject = readObject(step);
    if (!stepObject) continue;
    lines.push(`  ${renderPlanStatus(readString(stepObject, "status"))} ${readString(stepObject, "step") ?? ""}`);
  }
  const streaming = readString(object, "streaming");
  if (steps.length === 0 && streaming) {
    lines.push(`  ${streaming}`);
  }
  return lines.join("\n");
}

export function renderPlanStatus(status: unknown): string {
  if (status === "completed" || status === "complete") return "✓";
  if (status === "inProgress" || status === "in_progress" || status === "running") return "▶";
  if (status === "failed" || status === "blocked") return "!";
  if (status === "skipped") return "-";
  return "○";
}

function renderStructuredDisclosureData(data: unknown): string | undefined {
  const object = readObject(data);
  if (!object) return undefined;
  const parts: string[] = [];
  if (object.goal !== undefined) parts.push(renderGoal(object.goal));
  if (object.plan !== undefined) parts.push(renderPlan(object.plan));
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(object: Record<string, unknown>, key: string): string | undefined {
  return typeof object[key] === "string" ? object[key] : undefined;
}

function readNumber(object: Record<string, unknown>, key: string): number | undefined {
  return typeof object[key] === "number" ? object[key] : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
