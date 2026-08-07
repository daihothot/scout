import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import React from "react";
import { renderToString } from "ink";
import {
  buildActivityBarPresentation,
  resolveActivityBarRows,
} from "../../src/interaction/tui/chrome/activity-bar.js";
import {
  buildRunLifecycleProgressPresentation,
  buildSubprocessStatusPresentation,
  resolveTopChromeRows,
  TopChrome,
} from "../../src/interaction/tui/chrome/top-chrome.js";
import {
  buildSegmentedProgressTrack,
  buildSubprocessProgressPresentation,
  subprocessProgressStatusText,
} from "../../src/interaction/tui/chrome/subprocess-progress-bar.js";
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
import type { RunLifecycleSnapshot } from "../../src/run/lifecycle/index.js";

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

test("terminal markdown renders inline code with a pale foreground", () => {
  const lines = buildTerminalMarkdownLines("任务 `researcher-task-0001` 已指派。", 80);
  const code = lines[0]?.spans.find((span) => span.text === "researcher-task-0001");

  assert.deepEqual(code?.style, {
    color: "#c1beb0",
  });
});

test("terminal markdown renders fenced code with a pale foreground", () => {
  const lines = buildTerminalMarkdownLines("```gherkin\nGiven 已提供 BDD 目标\n```", 80);
  const language = lines.find((line) => line.spans.some((span) => span.text === "[gherkin]"));
  const code = lines.find((line) => line.spans.some((span) => span.text === "Given 已提供 BDD 目标"));

  assert.deepEqual(language?.spans[0]?.style, {
    color: "gray",
    dimColor: true,
  });
  assert.deepEqual(code?.spans[0]?.style, {
    color: "#a898a9",
  });
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

test("Run lifecycle progress scales its fill and caps its width", () => {
  const snapshot: RunLifecycleSnapshot = {
    runId: "run-boot",
    status: "starting",
    completedStages: 4,
    totalStages: 9,
    stages: [],
  };

  for (const width of [20, 40, 80]) {
    const presentation = buildRunLifecycleProgressPresentation(snapshot, width);
    const expectedWidth = width === 20 ? 20 : width === 40 ? 38 : 53;
    assert.equal(
      terminalDisplayWidth(`${presentation.filled}${presentation.remaining}`),
      expectedWidth,
    );
    assert.equal(presentation.width, expectedWidth);
    assert.match(`${presentation.filled}${presentation.remaining}`, /██▉██/);
    assert.equal(`${presentation.filled}${presentation.remaining}`.includes(" "), false);
  }
});

test("Segmented progress preserves a visible gap at the fill boundary", () => {
  const presentation = buildSegmentedProgressTrack({
    completedUnits: 1,
    totalUnits: 2,
    width: 12,
    maxWidth: 12,
    filledCell: "█",
    remainingCell: "█",
    cellWidth: 2,
    separator: "▉",
  });

  assert.equal(presentation.width, 11);
  assert.equal(presentation.filled, "██▉██▉");
  assert.equal(presentation.remaining, "██▉██");
  assert.equal(
    terminalDisplayWidth(`${presentation.filled}${presentation.remaining}`),
    presentation.width,
  );

  const narrow = buildSegmentedProgressTrack({
    completedUnits: 0,
    totalUnits: 0,
    width: 1,
    maxWidth: 42,
    filledCell: "█",
    remainingCell: "█",
    cellWidth: 2,
  });
  assert.deepEqual(narrow, { width: 1, filled: "", remaining: "█" });
});

test("Subprocess progress accepts module-independent content and units", () => {
  const content = {
    marker: "▷",
    label: "workspace",
    detail: "indexing",
    units: "2/5",
  };
  const presentation = buildSubprocessProgressPresentation({
    completedUnits: 2,
    totalUnits: 5,
    content,
    width: 40,
    maxBarWidth: 12,
  });

  assert.equal(presentation.width, 12);
  assert.equal(presentation.filled, "▬".repeat(5));
  assert.equal(presentation.remaining, "▭".repeat(7));
  assert.deepEqual(presentation.content, content);
  assert.equal(subprocessProgressStatusText(content), "▷ workspace  indexing  2/5");
  assert.equal(subprocessProgressStatusText(content, true), "workspace▷indexing 2/5");
});

test("Subprocess descriptor drives progress content and stable chrome rows", () => {
  const progress = {
    id: "mount-restore",
    phase: "running" as const,
    completedUnits: 8,
    totalUnits: 14,
    descriptor: {
      status: {
        marker: "*",
        label: "Preparing Scout runtime",
        detail: "Mount · preflight · validator",
        tone: "active" as const,
      },
      progress: {
        marker: "▶",
        label: "validator",
        detail: "config",
        units: "8/14",
        tone: "active" as const,
      },
    },
  };
  const presentation = buildSubprocessProgressPresentation({
    completedUnits: progress.completedUnits,
    totalUnits: progress.totalUnits,
    content: progress.descriptor.progress,
    width: 80,
    maxBarWidth: 53,
  });

  assert.equal(presentation.width, 53);
  assert.deepEqual(presentation.content, {
    marker: "▶",
    label: "validator",
    detail: "config",
    tone: "active",
    units: "8/14",
  });
  assert.equal(presentation.filled, "▬".repeat(30));
  assert.equal(presentation.remaining, "▭".repeat(23));
  const preflight = buildSubprocessProgressPresentation({
    completedUnits: progress.completedUnits,
    totalUnits: progress.totalUnits,
    content: { ...progress.descriptor.progress, detail: "preflight" },
    width: 80,
    maxBarWidth: 53,
  });
  assert.deepEqual(preflight.content, {
    marker: "▶",
    label: "validator",
    detail: "preflight",
    tone: "active",
    units: "8/14",
  });
  assert.equal(buildSubprocessProgressPresentation({
    completedUnits: progress.completedUnits,
    totalUnits: progress.totalUnits,
    content: { ...progress.descriptor.progress, detail: undefined },
    width: 80,
    maxBarWidth: 53,
  }).content.detail, undefined);
  assert.deepEqual(
    buildSubprocessStatusPresentation(progress.descriptor.status),
    {
      marker: "*",
      label: "Preparing Scout runtime",
      detail: "Mount · preflight · validator",
      color: "yellow",
    },
  );
  assert.deepEqual(
    buildSubprocessStatusPresentation({
      marker: "!",
      label: "Mount restore failed",
      detail: "validator preflight",
      tone: "failed",
    }),
    {
      marker: "!",
      label: "Mount restore failed",
      detail: "validator preflight",
      color: "red",
    },
  );
  assert.deepEqual(buildSubprocessStatusPresentation({
    marker: "*",
    label: "Preparing Scout runtime",
    detail: "Mount · verifying · 4/4 reusable",
    tone: "active",
  }), {
    marker: "*",
    label: "Preparing Scout runtime",
    detail: "Mount · verifying · 4/4 reusable",
    color: "yellow",
  });
  assert.deepEqual(buildSubprocessStatusPresentation({
    marker: "*",
    label: "Preparing Scout runtime",
    detail: "Mount · preflight · researcher",
    tone: "active",
  }), {
    marker: "*",
    label: "Preparing Scout runtime",
    detail: "Mount · preflight · researcher",
    color: "yellow",
  });
  assert.equal(resolveTopChromeRows(false, true, progress), 27);
  assert.equal(resolveTopChromeRows(true, true, progress), 14);
  assert.equal(resolveTopChromeRows(false, true, {
    ...progress,
    descriptor: { status: progress.descriptor.status },
  }), 21);
  assert.equal(resolveTopChromeRows(false, false), 17);
  assert.equal(resolveTopChromeRows(true, false), 12);

  const compactText = subprocessProgressStatusText({
    marker: "▷",
    label: "validator",
    detail: "config",
    units: "8/14",
  }, true);
  const compactLifecycle = buildRunLifecycleProgressPresentation({
    runId: "run-boot",
    status: "starting",
    completedStages: 4,
    totalStages: 9,
    stages: [],
  }, 40, compactText);
  assert.ok(compactLifecycle.width <= 16);
  assert.ok(
    terminalDisplayWidth(
      `${compactLifecycle.filled}${compactLifecycle.remaining}  ${compactText}`,
    ) <= 40,
  );
});

test("Top chrome matches the full mount layout at normal and boundary widths", () => {
  const mountRestore = {
    id: "mount-restore",
    phase: "running" as const,
    completedUnits: 11,
    totalUnits: 24,
    descriptor: {
      status: {
        marker: "*",
        label: "Preparing Scout runtime",
        detail: "Mount · preflight · researcher",
        tone: "active" as const,
      },
      progress: {
        marker: "›",
        label: "researcher",
        detail: "preflight",
        units: "11/24",
        tone: "active" as const,
      },
    },
  };
  const state = tuiState({
    runtime: {
      cwd: "/Users/chengdai/Documents/DevopsProjects/scout",
      version: "0.1.0",
      model: "gpt-5.5",
      reasoningEffort: "high",
      runId: "run-20260806T090308",
      status: "preparing",
    },
    lifecycle: {
      runId: "run-20260806T090308",
      status: "starting",
      completedStages: 4,
      totalStages: 9,
      stages: [],
    },
    subprocessProgress: mountRestore,
  });
  const previousMotion = process.env.SCOUT_TUI_MOTION;
  process.env.SCOUT_TUI_MOTION = "0";
  try {
    for (const { terminalWidth, contentWidth, runTail } of [
      { terminalWidth: 100, contentWidth: 96, runTail: "6T090308" },
      { terminalWidth: 68, contentWidth: 64, runTail: "308" },
    ]) {
      const output = stripVTControlCharacters(renderToString(
        React.createElement(TopChrome, {
          state,
          activeTasks: 0,
          compact: false,
          width: contentWidth,
        }),
        { columns: terminalWidth },
      ));
      const lines = output.split("\n");
      const cardLine = lines.find((line) => line.includes("status: preparing"));
      assert.ok(cardLine);
      assert.ok(cardLine.includes(
        `status: preparing  run: ${runTail}  model: gpt-5.5  reasoning: high`,
      ));
      const activityLine = lines.find((line) => line.includes("activity: 0 items"));
      assert.ok(activityLine?.includes("activity: 0 items  tasks: 0  dir: "));
      const cardTitleIndex = lines.findIndex((line) => line.includes("validation runtime"));
      assert.ok(cardTitleIndex >= 0);
      assert.match(lines[cardTitleIndex + 1] ?? "", /^│ +│$/);
      assert.equal(lines[cardTitleIndex + 2], cardLine);
      assert.match(lines[cardTitleIndex + 3] ?? "", /^│ +│$/);
      assert.equal(lines[cardTitleIndex + 4], activityLine);

      const statusIndex = lines.findIndex((line) => line.includes("Preparing Scout runtime"));
      assert.ok(statusIndex >= 0);
      assert.equal(lines[statusIndex + 1], "");
      assert.equal(lines[statusIndex + 2], "  Mount · preflight · researcher");
      assert.equal(lines[statusIndex + 3], "");
      assert.match(lines[statusIndex + 4] ?? "", /^  ██▉██/);
      assert.equal(lines[statusIndex + 5], "");
      assert.equal(lines[statusIndex + 6], "");
      assert.match(lines[statusIndex + 7] ?? "", /^› researcher  preflight  11\/24/);
      assert.equal(lines[statusIndex + 8], "");
      assert.match(lines[statusIndex + 9] ?? "", /^  ▬▬/);
      assert.equal(lines[statusIndex + 9]?.includes(" ", 2), false);
    }
  } finally {
    if (previousMotion === undefined) delete process.env.SCOUT_TUI_MOTION;
    else process.env.SCOUT_TUI_MOTION = previousMotion;
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

test("activity strip presents context compaction independently from turn processing", () => {
  const started = selectCurrentAgentActivity(tuiState({
    activities: [{
      seq: 2,
      agentId: "coordinator",
      role: "coordinator",
      threadId: "thread-coordinator",
      turnId: "turn-1",
      itemId: "compaction-1",
      type: "contextCompaction",
      status: "inProgress",
      label: "Context compaction",
      updatedAt: "2026-07-10T00:00:02.000Z",
    }],
  }));
  const completed = selectCurrentAgentActivity(tuiState({
    activities: [{
      seq: 2,
      agentId: "coordinator",
      role: "coordinator",
      threadId: "thread-coordinator",
      turnId: "turn-1",
      itemId: "compaction-1",
      type: "contextCompaction",
      status: "completed",
      label: "Context compaction",
      updatedAt: "2026-07-10T00:00:02.000Z",
    }],
    turnActivities: [{
      seq: 1,
      agentId: "coordinator",
      role: "coordinator",
      threadId: "thread-coordinator",
      turnId: "turn-1",
      status: "inProgress",
      updatedAt: "2026-07-10T00:00:01.000Z",
    }],
  }));
  const failed = selectCurrentAgentActivity(tuiState({
    activities: [{
      seq: 2,
      agentId: "coordinator",
      role: "coordinator",
      threadId: "thread-coordinator",
      turnId: "turn-1",
      itemId: "compaction-1",
      type: "contextCompaction",
      status: "failed",
      label: "Context compaction",
      updatedAt: "2026-07-10T00:00:02.000Z",
    }],
  }));

  assert.deepEqual(
    started && [started.processing, started.markdown, started.activity],
    [false, false, "压缩上下文"],
  );
  assert.deepEqual(
    completed && [completed.processing, completed.markdown, completed.activity],
    [false, false, "压缩完成"],
  );
  assert.equal(completed?.activity.startsWith("处理中 ·"), false);
  assert.equal(failed?.activity, "上下文压缩失败");
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
