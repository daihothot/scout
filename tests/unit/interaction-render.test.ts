import test from "node:test";
import assert from "node:assert/strict";
import { renderEventNotification, renderGoal, renderPlan, renderPlanStatus } from "../../src/interaction/cli/render.js";
import { renderTaskNotificationXml } from "../../src/interaction/protocol/task-notification.js";
import {
  renderHumanInputPrompt,
  renderUserInputRequestNotification,
  renderUserInputResponse,
} from "../../src/interaction/protocol/user-input.js";
import type { AgentTaskState } from "../../src/agent/task/types.js";
import type {
  AgentTaskEventPayload,
  AgentTaskSystemEvent,
  SystemInterruptEventPayload,
} from "../../src/agent/task/task-events.js";
import type { ScoutEvent } from "../../src/core/events/index.js";
import { ScoutAgentRoles } from "../../src/agent/model/types.js";
import { InMemoryEventBus, SystemEvents } from "../../src/core/events/index.js";

test("task notification XML escapes task content and renders outcome refs", () => {
  const xml = renderTaskNotificationXml(task({
    status: "blocked",
    outcome: {
      status: "blocked",
      summary: "证据 <不足> & 需要确认",
      artifactRefs: ["artifact://report?x=1&y=2"],
      evidenceRefs: ["evidence://line<'1'>"],
      blocker: "缺少用户确认",
      emittedAt: "2026-06-29T00:00:00.000Z",
    },
    result: "raw <result>",
  }));

  assert.match(xml, /<status>blocked<\/status>/);
  assert.match(xml, /证据 &lt;不足&gt; &amp; 需要确认/);
  assert.match(xml, /artifact:\/\/report\?x=1&amp;y=2/);
  assert.match(xml, /evidence:\/\/line&lt;&apos;1&apos;&gt;/);
  assert.match(xml, /raw &lt;result&gt;/);
});

test("user input protocol renders request, human prompt and escaped response", () => {
  const request = {
    requestId: "request-1",
    agentId: "verifier",
    taskId: "task-1",
    kind: "prompt_required" as const,
    question: "选 <A> 还是 B?",
    context: "Worker 发现两个方案 & 都可行",
    options: ["A <fast>", "B & safe"],
    createdAt: "2026-06-29T00:00:00.000Z",
    status: "pending" as const,
  };
  const event = humanInputEvent({
    task: task({ description: "选择方案" }),
    request,
  });

  const payload = renderUserInputRequestNotification({
    task: event.payload.task,
    request,
  });
  assert.match(payload, /选 &lt;A&gt; 还是 B\?/);
  assert.equal(renderHumanInputPrompt(event), [
    "Agent 执行过程中需要用户输入。",
    "上下文：Worker 发现两个方案 & 都可行",
    "问题：选 <A> 还是 B?",
    "1. A <fast>",
    "2. B & safe",
  ].join("\n"));
  const renderedResponse = renderUserInputResponse(event, "选择 A & 继续");
  assert.match(renderedResponse, /<request-id>request-1<\/request-id>/);
  assert.match(renderedResponse, /选择 A &amp; 继续/);
});

test("event rendering delegates task terminal and human-input interrupt notifications", () => {
  const terminalEvent = taskTerminalEvent(task({
    status: "complete",
    result: "done <ok>",
  }));
  const humanEvent = humanInputEvent({
    task: task({ description: "选择方案" }),
    request: {
      requestId: "request-1",
      agentId: "verifier",
      taskId: "task-1",
      kind: "prompt_required",
      question: "选 <A> 还是 B?",
      createdAt: "2026-06-29T00:00:00.000Z",
      status: "pending",
    },
  });

  assert.match(renderEventNotification(terminalEvent), /<task-notification>/);
  assert.match(renderEventNotification(terminalEvent), /done &lt;ok&gt;/);
  assert.match(renderEventNotification(humanEvent), /<user-input-request-notification>/);
  assert.match(renderEventNotification(humanEvent), /选 &lt;A&gt; 还是 B\?/);
});

test("CLI render formats goal and plan status", () => {
  assert.equal(renderPlanStatus("completed"), "✓");
  assert.equal(renderPlanStatus("in_progress"), "▶");
  assert.equal(renderPlanStatus("blocked"), "!");
  assert.equal(renderPlanStatus("skipped"), "-");
  assert.equal(renderPlanStatus("pending"), "○");
  assert.equal(renderGoal({
    objective: "Optimize p95",
    status: "active",
    tokensUsed: 10,
    tokenBudget: 100,
  }), [
    "Goal:",
    "  objective: Optimize p95",
    "  status: active",
    "  tokens: 10/100",
  ].join("\n"));
  assert.equal(renderPlan({
    explanation: "验证路径",
    steps: [
      { step: "复现", status: "completed" },
      { step: "修复", status: "inProgress" },
    ],
  }), [
    "Plan:",
    "  验证路径",
    "  ✓ 复现",
    "  ▶ 修复",
  ].join("\n"));
});

function taskTerminalEvent(taskState: AgentTaskState): AgentTaskSystemEvent {
  const bus = new InMemoryEventBus();
  return bus.publish(SystemEvents.task.terminal, {
    task: taskState,
  } satisfies AgentTaskEventPayload, {
    id: "event-1",
    occurredAt: "2026-06-29T00:00:00.000Z",
  }) as AgentTaskSystemEvent;
}

function humanInputEvent(input: {
  task: AgentTaskState;
  request: NonNullable<SystemInterruptEventPayload["request"]>;
}): ScoutEvent<SystemInterruptEventPayload> {
  const bus = new InMemoryEventBus();
  return bus.publish(SystemEvents.interrupt.raised, {
    interruptKind: "human_input",
    taskId: input.task.taskId,
    agentId: input.task.agentId,
    requestId: input.request.requestId,
    request: input.request,
    task: input.task,
  } satisfies SystemInterruptEventPayload, {
    id: "event-human-input",
    occurredAt: "2026-06-29T00:00:00.000Z",
  });
}

function task(input: Partial<AgentTaskState> = {}): AgentTaskState {
  return {
    type: "local_agent",
    taskId: "task-1",
    agentId: "verifier",
    role: ScoutAgentRoles.Verifier,
    description: "验证 <BDD>",
    prompt: "验证",
    selectedAgent: ScoutAgentRoles.Verifier,
    status: "running",
    isBackgrounded: true,
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z",
    ...input,
  };
}
