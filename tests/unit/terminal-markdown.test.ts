import assert from "node:assert/strict";
import test from "node:test";
import {
  buildActivityRows,
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
        agentId: "researcher",
        text: "Second",
        createdAt: "2026-07-10T00:00:01.000Z",
      },
    ],
  };

  const rows = buildActivityRows(state, 40);
  assert.equal(rows.filter((row) => row.spacer).length, 1);
  assert.equal(rows.at(-1)?.spacer, undefined);
  assert.equal(rows.some((row) => row.text === "" && !row.spacer), true);
});

function lineText(line: { spans: Array<{ text: string }> }): string {
  return line.spans.map((span) => span.text).join("");
}
