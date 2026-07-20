import assert from "node:assert/strict";
import test from "node:test";
import {
  buildActivityBarPresentation,
  resolveActivityBarRows,
} from "../../src/interaction/tui/chrome/activity-bar.js";
import { buildBootProgressPresentation } from "../../src/interaction/tui/chrome/top-chrome.js";
import { buildChatVisualRows } from "../../src/interaction/tui/panels/chat-panel.js";
import { buildCoordinatorMessageRows } from "../../src/interaction/tui/rows/coordinator-message-row.js";
import { taskMarker } from "../../src/interaction/tui/markers.js";
import {
  selectCurrentAgentActivity,
  selectChatItems,
} from "../../src/interaction/tui/selectors/index.js";
import {
  buildTerminalMarkdownLines,
} from "../../src/interaction/tui/terminal-markdown.js";
import { terminalDisplayWidth } from "../../src/interaction/tui/terminal-text.js";
import type { TuiState } from "../../src/interaction/tui/tui-store.js";
import type { BootSnapshot } from "../../src/run/boot/boot-stage.js";

test("terminal markdown renders headings as separate styled blocks", () => {
  const lines = buildTerminalMarkdownLines(
    "# Main title\n\nParagraph with **bold** text.\n\n## Details",
    40,
  );

  assert.deepEqual(lines.map((line) => line.kind), [
    "heading",
    "blank",
    "text",
    "blank",
    "heading",
  ]);
  assert.deepEqual(lines.map(lineText), [
    "Main title",
    "",
    "Paragraph with bold text.",
    "",
    "Details",
  ]);
  assert.deepEqual(lines[0]?.spans[0]?.style, {
    bold: true,
    color: "cyan",
    underline: true,
  });
});

test("terminal markdown renders lists and wraps using terminal display width", () => {
  const lines = buildTerminalMarkdownLines("- **first**\n- 你好世界", 8);

  assert.equal(lines.some((line) => lineText(line).startsWith("• first")), true);
  assert.ok(lines.every((line) => terminalDisplayWidth(lineText(line)) <= 8));
  assert.equal(
    lines.map(lineText).join("").replace(/[•\s]/g, "").includes("你好世界"),
    true,
  );
});

test("Chat projection keeps semantic rows and one spacer between messages", () => {
  const state = tuiState({
    logs: [
      {
        id: "log-1",
        kind: "input",
        text: "开始检查",
        createdAt: "2026-07-10T00:00:00.000Z",
      },
      {
        id: "log-2",
        kind: "agent",
        agentId: "coordinator",
        text: "# 已接收\n\n准备分配任务。",
        createdAt: "2026-07-10T00:00:01.000Z",
      },
      {
        id: "log-3",
        kind: "system",
        text: "任务 researcher-task-0001 已指派。",
        createdAt: "2026-07-10T00:00:02.000Z",
      },
    ],
  });

  const rows = buildChatVisualRows(selectChatItems(state), 40);
  assert.equal(rows.filter((row) => row.kind === "spacer").length, 2);
  assert.equal(rows.some((row) => row.kind === "user" && row.text.includes("开始检查")), true);
  assert.equal(rows.some((row) => row.kind === "coordinator" && row.text === "已接收"), true);
  assert.equal(rows.some((row) => row.kind === "system" && row.text.includes("已指派")), true);
});

test("Coordinator message rows reflow without exceeding terminal width", () => {
  const text = "核验 verification-report.md 的证据链，并保留当前版本代码证据。".repeat(4);
  for (const width of [20, 40, 80, 120]) {
    const rows = buildCoordinatorMessageRows({
      id: "coord-1",
      kind: "coordinator",
      text,
      createdAt: "2026-07-10T00:00:00.000Z",
    }, width).filter((row) => !row.prefixOnly);
    assert.ok(rows.length > 1);
    assert.ok(rows.every((row) =>
      row.leadingWidth + terminalDisplayWidth(row.text) <= width
    ));
  }
});

test("Boot progress scales its fill and caps its width", () => {
  const snapshot: BootSnapshot = {
    runId: "run-boot",
    status: "starting",
    completedStages: 4,
    totalStages: 9,
    stages: [],
  };

  for (const width of [20, 40, 80]) {
    const presentation = buildBootProgressPresentation(snapshot, width);
    const expectedWidth = Math.min(width, 42);
    assert.equal(
      terminalDisplayWidth(`${presentation.filled}${presentation.remaining}`),
      expectedWidth,
    );
    assert.equal(presentation.width, expectedWidth);
  }
});

test("activity strip retains the latest Agent activity after it completes", () => {
  const state = tuiState({
    activities: [
      {
        seq: 1,
        agentId: "coordinator",
        role: "coordinator",
        threadId: "thread-coordinator",
        itemId: "item-coordinator",
        type: "reasoning",
        status: "inProgress",
        label: "Reasoning",
        detail: "正在指派任务",
        updatedAt: "2026-07-10T00:00:01.000Z",
      },
      {
        seq: 2,
        agentId: "researcher",
        role: "researcher",
        taskId: "researcher-task-0001",
        threadId: "thread-researcher",
        itemId: "item-researcher",
        type: "reasoning",
        status: "completed",
        label: "Reasoning",
        detail: "正在**定位 BDD 证据**并整理完整研究产物",
        updatedAt: "2026-07-10T00:00:02.000Z",
      },
    ],
  });

  const activity = selectCurrentAgentActivity(state);
  assert.deepEqual(
    activity && [
      activity.label,
      activity.taskId,
      activity.type,
      activity.markdown,
      activity.status,
      activity.processing,
      activity.activity,
    ],
    [
      "RES",
      "researcher-task-0001",
      "reasoning",
      true,
      "completed",
      false,
      "已思考 · 正在**定位 BDD 证据**并整理完整研究产物",
    ],
  );
  assert.ok(resolveActivityBarRows(activity, 24) > 1);
  const spans = buildActivityBarPresentation(activity, 80).lines.flat();
  assert.equal(spans.map((span) => span.text).join("").includes("**"), false);
  assert.equal(
    spans.some((span) => span.text === "定位 BDD 证据" && span.style?.bold),
    true,
  );
});

test("activity strip replaces retained activity only when a newer activity arrives", () => {
  const activity = selectCurrentAgentActivity(tuiState({
    activities: [
      {
        seq: 4,
        agentId: "researcher",
        role: "researcher",
        taskId: "researcher-task-0001",
        threadId: "thread-researcher",
        itemId: "item-researcher",
        type: "reasoning",
        status: "completed",
        label: "Reasoning",
        detail: "研究工作完成",
        updatedAt: "2026-07-10T00:00:04.000Z",
      },
      {
        seq: 5,
        agentId: "coordinator",
        role: "coordinator",
        threadId: "thread-coordinator",
        itemId: "item-coordinator",
        type: "reasoning",
        status: "inProgress",
        label: "Reasoning",
        detail: "正在检查研究结果",
        updatedAt: "2026-07-10T00:00:05.000Z",
      },
    ],
  }));

  assert.deepEqual(
    activity && [activity.label, activity.type, activity.status, activity.activity],
    ["COORD", "reasoning", "inProgress", "思考 · 正在检查研究结果"],
  );
});

test("activity strip uses turn lifecycle instead of task status for process presentation", () => {
  const completedReasoning = {
    seq: 1,
    agentId: "researcher",
    role: "researcher" as const,
    taskId: "researcher-task-0001",
    threadId: "thread-researcher",
    turnId: "turn-1",
    itemId: "item-researcher",
    type: "reasoning",
    status: "completed",
    label: "Reasoning",
    detail: "整理证据",
    updatedAt: "2026-07-10T00:00:01.000Z",
  };
  const processing = selectCurrentAgentActivity(tuiState({
    activities: [completedReasoning],
    turnActivities: [{
      seq: 0,
      agentId: "researcher",
      role: "researcher",
      taskId: "researcher-task-0001",
      threadId: "thread-researcher",
      turnId: "turn-1",
      status: "inProgress",
      updatedAt: "2026-07-10T00:00:00.000Z",
    }],
    tasks: [{
      taskId: "researcher-task-0001",
      taskSequence: 1,
      role: "researcher",
      status: "done",
      description: "整理研究证据",
      updatedAt: "2026-07-10T00:00:01.000Z",
      planSteps: [],
    }],
  }));
  const completed = selectCurrentAgentActivity(tuiState({
    activities: [completedReasoning],
    turnActivities: [{
      seq: 2,
      agentId: "researcher",
      role: "researcher",
      taskId: "researcher-task-0001",
      threadId: "thread-researcher",
      turnId: "turn-1",
      status: "completed",
      updatedAt: "2026-07-10T00:00:02.000Z",
    }],
  }));

  assert.deepEqual(
    processing && [processing.processing, processing.activity],
    [true, "处理中 · 已思考 · 整理证据"],
  );
  assert.deepEqual(
    completed && [completed.processing, completed.activity],
    [false, "已思考 · 整理证据"],
  );
});

test("activity strip shows process during Coordinator and Worker item gaps", () => {
  const coordinator = selectCurrentAgentActivity(tuiState({
    turnActivities: [{
      seq: 1,
      agentId: "coordinator",
      role: "coordinator",
      threadId: "thread-coordinator",
      turnId: "turn-coordinator-1",
      status: "inProgress",
      updatedAt: "2026-07-10T00:00:01.000Z",
    }],
  }));
  const worker = selectCurrentAgentActivity(tuiState({
    activities: [{
      seq: 2,
      agentId: "researcher",
      role: "researcher",
      taskId: "researcher-task-0001",
      threadId: "thread-researcher",
      turnId: "turn-researcher-1",
      itemId: "command-1",
      type: "commandExecution",
      status: "completed",
      label: "rg BDD-001",
      updatedAt: "2026-07-10T00:00:02.000Z",
    }],
    turnActivities: [{
      seq: 1,
      agentId: "researcher",
      role: "researcher",
      taskId: "researcher-task-0001",
      threadId: "thread-researcher",
      turnId: "turn-researcher-1",
      status: "inProgress",
      updatedAt: "2026-07-10T00:00:01.000Z",
    }],
  }));

  assert.deepEqual(
    coordinator && [coordinator.label, coordinator.type, coordinator.processing, coordinator.activity],
    ["COORD", "turn", true, "处理中"],
  );
  assert.deepEqual(
    worker && [worker.label, worker.type, worker.processing, worker.activity],
    ["RES", "commandExecution", true, "处理中 · 已执行 · rg BDD-001"],
  );
});

test("turn completion makes a stale in-progress item static", () => {
  const activity = selectCurrentAgentActivity(tuiState({
    activities: [{
      seq: 2,
      agentId: "researcher",
      role: "researcher",
      taskId: "researcher-task-0001",
      threadId: "thread-researcher",
      turnId: "turn-researcher-1",
      itemId: "reasoning-1",
      type: "reasoning",
      status: "inProgress",
      label: "Reasoning",
      detail: "整理证据",
      updatedAt: "2026-07-10T00:00:02.000Z",
    }],
    turnActivities: [{
      seq: 3,
      agentId: "researcher",
      role: "researcher",
      taskId: "researcher-task-0001",
      threadId: "thread-researcher",
      turnId: "turn-researcher-1",
      status: "completed",
      updatedAt: "2026-07-10T00:00:03.000Z",
    }],
  }));

  assert.deepEqual(
    activity && [activity.status, activity.processing, activity.activity],
    ["completed", false, "已思考 · 整理证据"],
  );
});

test("activity strip displays command labels instead of command working directories", () => {
  const activity = selectCurrentAgentActivity(tuiState({
    activities: [{
      seq: 1,
      agentId: "researcher",
      role: "researcher",
      taskId: "researcher-task-0001",
      threadId: "thread-researcher",
      itemId: "command-1",
      type: "commandExecution",
      status: "completed",
      label: "rg \"login retry\" src",
      detail: "/run/agents/researcher/mount",
      updatedAt: "2026-07-10T00:00:01.000Z",
    }],
  }));

  assert.deepEqual(
    activity && [activity.type, activity.markdown, activity.activity],
    ["commandExecution", false, "已执行 · rg \"login retry\" src"],
  );
});

test("selected task marker is distinct from running and archived markers", () => {
  assert.equal(taskMarker("running", true), "▶");
  assert.equal(taskMarker("archived", true), "▶");
  assert.equal(taskMarker("running", false), "→");
  assert.equal(taskMarker("archived", false), "□");
});

function lineText(line: { spans: Array<{ text: string }> }): string {
  return line.spans.map((span) => span.text).join("");
}

function tuiState(input: Partial<TuiState> = {}): TuiState {
  return {
    runtime: {
      cwd: "/repo/scout",
      version: "0.1.0",
      model: "gpt-5.5",
      reasoningEffort: "high",
      status: "ready",
    },
    tasks: [],
    logs: [],
    activities: [],
    turnActivities: [],
    ...input,
  };
}
