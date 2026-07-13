import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCoordinatorActivityRows,
  buildWorkerActivityRows,
  resolveTuiWidths,
} from "../../src/interaction/tui/scout-tui-app.js";
import {
  buildTerminalMarkdownLines,
} from "../../src/interaction/tui/terminal-markdown.js";
import { terminalDisplayWidth } from "../../src/interaction/tui/terminal-text.js";
import type { TuiState } from "../../src/interaction/tui/tui-store.js";

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
  assert.equal(
    lines[2]?.spans.some((span) => span.text === "bold" && span.style?.bold),
    true,
  );
  assert.deepEqual(lines[4]?.spans[0]?.style, {
    bold: true,
    color: "cyan",
  });
});

test("terminal markdown renders lists and wraps using terminal display width", () => {
  const lines = buildTerminalMarkdownLines("- **first**\n- 你好世界", 8);

  assert.equal(lines.some((line) => lineText(line).startsWith("• first")), true);
  assert.equal(lines.some((line) => line.spans.some((span) => span.text === "first" && span.style?.bold)), true);
  assert.ok(lines.every((line) => terminalDisplayWidth(lineText(line)) <= 8));
  assert.equal(
    lines.map(lineText).join("").replace(/[•\s]/g, "").includes("你好世界"),
    true,
  );
});

test("activity rows include one explicit spacer between entries", () => {
  const state: TuiState = {
    runtime: {
      cwd: "/repo/scout",
      version: "0.1.0",
      model: "gpt-5.5",
      reasoningEffort: "high",
      status: "ready",
    },
    tasks: [],
    progress: [],
    logs: [
      {
        id: "log-1",
        kind: "agent",
        agentId: "coordinator",
        text: "# First\n\nBody",
        createdAt: "2026-07-10T00:00:00.000Z",
      },
      {
        id: "log-2",
        kind: "agent",
        agentId: "coordinator",
        text: "Second",
        createdAt: "2026-07-10T00:00:01.000Z",
      },
    ],
  };

  const rows = buildCoordinatorActivityRows(state, 40);
  assert.equal(rows.filter((row) => row.spacer).length, 1);
  assert.equal(rows.at(-1)?.spacer, undefined);
  assert.equal(rows.some((row) => row.text === "" && !row.spacer), true);
});

test("TUI widths derive every horizontal region from terminal columns", () => {
  assert.deepEqual(resolveTuiWidths(20), {
    terminalWidth: 20,
    rootPaddingX: 0,
    contentWidth: 20,
    inputValueWidth: 14,
  });
  assert.deepEqual(resolveTuiWidths(40), {
    terminalWidth: 40,
    rootPaddingX: 1,
    contentWidth: 38,
    inputValueWidth: 32,
  });
  assert.deepEqual(resolveTuiWidths(80), {
    terminalWidth: 80,
    rootPaddingX: 2,
    contentWidth: 76,
    inputValueWidth: 70,
  });
  assert.deepEqual(resolveTuiWidths(120), {
    terminalWidth: 120,
    rootPaddingX: 2,
    contentWidth: 116,
    inputValueWidth: 110,
  });
});

test("activity progress reflows without exceeding the current width", () => {
  const detail = JSON.stringify({
    taskId: "validator-task-0001",
    prompt: "核验 verification-report.md 的证据链，并保留当前版本代码证据。".repeat(4),
  });
  const state: TuiState = {
    runtime: {
      cwd: "/repo/scout",
      version: "0.1.0",
      model: "gpt-5.5",
      reasoningEffort: "high",
      status: "ready",
    },
    tasks: [],
    logs: [],
    progress: [{
      source: "agent.app_server.item",
      agentId: "validator",
      taskId: "validator-task-0001",
      itemId: "item-1",
      type: "functionCall",
      status: "completed",
      label: "AssignTask",
      detail,
      updatedAt: "2026-07-10T00:00:00.000Z",
    }],
  };

  for (const width of [20, 40, 80, 120]) {
    const rows = buildWorkerActivityRows(state, "validator-task-0001", width)
      .filter((row) => !row.spacer);
    assert.ok(rows.length > 1);
    assert.ok(rows.every((row) =>
      row.leadingWidth + terminalDisplayWidth(row.text) <= width
    ));
    assert.equal(
      rows.filter((row) => !row.prefixOnly).map((row) => row.text).join(""),
      `AssignTask ${detail}`,
    );
  }
});

test("Coordinator and current Worker task activity stay in separate projections", () => {
  const state: TuiState = {
    runtime: {
      cwd: "/repo/scout",
      version: "0.1.0",
      model: "gpt-5.5",
      reasoningEffort: "high",
      status: "ready",
    },
    tasks: [],
    logs: [],
    progress: [
      progress("coordinator", undefined, "coord-1", "Coordinator reasoning"),
      progress("researcher", "researcher-task-0001", "worker-1", "Current task reasoning"),
      progress("researcher", "researcher-task-0002", "worker-2", "Next task reasoning"),
    ],
  };

  const coordinatorRows = buildCoordinatorActivityRows(state, 80);
  const workerRows = buildWorkerActivityRows(state, "researcher-task-0001", 80);

  assert.equal(coordinatorRows.some((row) => row.text.includes("Coordinator reasoning")), true);
  assert.equal(coordinatorRows.some((row) => row.text.includes("Current task reasoning")), false);
  assert.equal(workerRows.some((row) => row.text.includes("Current task reasoning")), true);
  assert.equal(workerRows.some((row) => row.text.includes("Next task reasoning")), false);
  assert.equal(workerRows.some((row) => row.text.includes("Coordinator reasoning")), false);
});

function lineText(line: { spans: Array<{ text: string }> }): string {
  return line.spans.map((span) => span.text).join("");
}

function progress(
  agentId: string,
  taskId: string | undefined,
  itemId: string,
  detail: string,
): TuiState["progress"][number] {
  return {
    source: "agent.app_server.item",
    agentId,
    taskId,
    itemId,
    type: "reasoning",
    status: "completed",
    label: "Reasoning",
    detail,
    updatedAt: `2026-07-10T00:00:0${itemId.endsWith("1") ? "1" : "2"}.000Z`,
  };
}
