import test from "node:test";
import assert from "node:assert/strict";
import { renderQueuedCommandNotification, renderGoal, renderPlan, renderPlanStatus } from "../../src/interaction/cli/render.js";
import { renderQueuedCommands } from "../../src/interaction/protocol/queued-command.js";
import { renderTaskNotificationXml } from "../../src/interaction/protocol/task-notification.js";
import {
  renderHumanInputPrompt,
  renderUserInputRequestNotification,
  renderUserInputResponse,
} from "../../src/interaction/protocol/user-input.js";
import type { RuntimeQueuedCommand } from "../../src/core/queue/message-queue.js";
import type { AgentTaskState } from "../../src/agent/task/types.js";
import { ScoutAgentRoles } from "../../src/agent/types.js";

test("task notification XML escapes task content and renders outcome refs", () => {
  const xml = renderTaskNotificationXml(task({
    status: "insufficient_evidence",
    outcome: {
      status: "insufficient_evidence",
      summary: "证据 <不足> & 需要确认",
      artifactRefs: ["artifact://report?x=1&y=2"],
      evidenceRefs: ["evidence://line<'1'>"],
      blocker: "缺少用户确认",
      emittedAt: "2026-06-29T00:00:00.000Z",
    },
    result: "raw <result>",
  }));

  assert.match(xml, /<status>insufficient_evidence<\/status>/);
  assert.match(xml, /证据 &lt;不足&gt; &amp; 需要确认/);
  assert.match(xml, /artifact:\/\/report\?x=1&amp;y=2/);
  assert.match(xml, /evidence:\/\/line&lt;&apos;1&apos;&gt;/);
  assert.match(xml, /raw &lt;result&gt;/);
});

test("user input protocol renders request, human prompt and escaped response", () => {
  const command = queuedCommand({
    type: "user_input",
    payload: renderUserInputRequestNotification({
      task: task({ description: "选择方案" }),
      request: {
        requestId: "request-1",
        agentId: "verifier",
        taskId: "task-1",
        kind: "prompt_required",
        question: "选 <A> 还是 B?",
        context: "Worker 发现两个方案 & 都可行",
        options: ["A <fast>", "B & safe"],
        createdAt: "2026-06-29T00:00:00.000Z",
      },
    }),
  });

  assert.match(command.payload, /选 &lt;A&gt; 还是 B\?/);
  assert.equal(renderHumanInputPrompt(command), [
    "Agent 执行过程中需要用户输入。",
    "上下文：Worker 发现两个方案 & 都可行",
    "问题：选 <A> 还是 B?",
    "1. A <fast>",
    "2. B & safe",
  ].join("\n"));
  assert.match(renderUserInputResponse(command, "选择 A & 继续"), /选择 A &amp; 继续/);
});

test("queued command rendering delegates task and user notifications and wraps system events", () => {
  const taskCommand = queuedCommand({ type: "task_notification", payload: "<task-notification />" });
  const userCommand = queuedCommand({ type: "user_input", payload: "<user-input-request-notification />" });
  const systemCommand = queuedCommand({
    id: "command<&>",
    type: "system_event",
    priority: "now",
    payload: "<system>raw</system>",
  });

  assert.equal(renderQueuedCommandNotification(taskCommand), "<task-notification />\n");
  assert.equal(renderQueuedCommandNotification(userCommand), "<user-input-request-notification />\n");
  assert.match(renderQueuedCommandNotification(systemCommand), /id="command&lt;&amp;&gt;"/);
  assert.match(renderQueuedCommandNotification(systemCommand), /<system>raw<\/system>/);
  assert.match(renderQueuedCommands([systemCommand]), /&lt;system&gt;raw&lt;\/system&gt;/);
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

function queuedCommand(input: Partial<RuntimeQueuedCommand>): RuntimeQueuedCommand {
  return {
    id: "queued-command-0001",
    type: "user_input",
    priority: "next",
    enqueuedAt: "2026-06-29T00:00:00.000Z",
    payload: "",
    ...input,
  };
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
