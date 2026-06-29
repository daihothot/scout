import type { AgentTaskState } from "../../agent/task/types.js";
import { escapeXml } from "./xml.js";

export function renderTaskNotificationXml(task: AgentTaskState): string {
  const result = task.result ?? task.error ?? "";
  const outcome = task.outcome;
  return [
    "<task-notification>",
    `  <task-id>${escapeXml(task.taskId)}</task-id>`,
    `  <agent-id>${escapeXml(task.agentId)}</agent-id>`,
    `  <status>${escapeXml(task.status)}</status>`,
    outcome ? "  <outcome>" : undefined,
    outcome ? `    <status>${escapeXml(outcome.status)}</status>` : undefined,
    outcome ? `    <summary>${escapeXml(outcome.summary)}</summary>` : undefined,
    outcome?.blocker ? `    <blocker>${escapeXml(outcome.blocker)}</blocker>` : undefined,
    outcome?.nextStep ? `    <next-step>${escapeXml(outcome.nextStep)}</next-step>` : undefined,
    ...(outcome?.artifactRefs ?? []).map((ref) => `    <artifact-ref>${escapeXml(ref)}</artifact-ref>`),
    ...(outcome?.evidenceRefs ?? []).map((ref) => `    <evidence-ref>${escapeXml(ref)}</evidence-ref>`),
    outcome ? "  </outcome>" : undefined,
    `  <summary>${escapeXml(renderTaskSummary(task))}</summary>`,
    `  <result>${escapeXml(result)}</result>`,
    "  <usage>",
    `    <total_tokens>${task.usage?.totalTokens ?? 0}</total_tokens>`,
    `    <tool_uses>${task.usage?.toolUses ?? 0}</tool_uses>`,
    `    <duration_ms>${task.usage?.durationMs ?? 0}</duration_ms>`,
    "  </usage>",
    "</task-notification>",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function renderTaskSummary(task: AgentTaskState): string {
  if (task.outcome) {
    return `Agent "${task.description}" outcome: ${task.outcome.status}`;
  }
  if (task.status === "complete") {
    return `Agent "${task.description}" completed`;
  }
  if (task.status === "prompt_required" || task.status === "confirmation_required") {
    return `Agent "${task.description}" requires user input`;
  }
  if (task.status === "blocked") {
    return `Agent "${task.description}" blocked`;
  }
  if (task.status === "insufficient_evidence") {
    return `Agent "${task.description}" reported insufficient evidence`;
  }
  if (task.status === "stopped") {
    return `Agent "${task.description}" stopped`;
  }
  if (task.status === "failed") {
    return `Agent "${task.description}" failed`;
  }
  if (task.status === "waiting_for_input") {
    return `Agent "${task.description}" is waiting for user input`;
  }
  return `Agent "${task.description}" is running`;
}
