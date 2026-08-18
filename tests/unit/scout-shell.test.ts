import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString, Text } from "ink";
import { PromptInput } from "../../src/interaction/tui/chrome/prompt-input.js";
import { ScoutShell } from "../../src/interaction/tui/shell/scout-shell.js";

test("ScoutShell clips overflowing top chrome without moving the prompt slot", () => {
  const output = renderToString(
    React.createElement(ScoutShell, {
      terminalWidth: 20,
      contentWidth: 20,
      appHeight: 10,
      rootPaddingX: 0,
      topChromeRows: 2,
      workspaceRows: 6,
      promptRows: 2,
      topChrome: React.createElement(
        Text,
        null,
        ["chrome-1", "\n", "chrome-2", "\n", "chrome-3", "\n", "chrome-4"],
      ),
      chatPanel: React.createElement(Text, null, "workspace"),
      tasksDrawer: null,
      activityBar: null,
      taskGapRows: 0,
      activityGapRows: 0,
      promptInput: React.createElement(Text, null, "prompt"),
    }),
    { columns: 20 },
  );

  const lines = output.split("\n");
  assert.deepEqual(lines.slice(0, 3), ["chrome-1", "chrome-2", "workspace"]);
  assert.equal(lines.at(-2), "prompt");
});

test("ScoutShell pins the prompt to the viewport bottom when workspace is empty", () => {
  const output = renderToString(
    React.createElement(ScoutShell, {
      terminalWidth: 20,
      contentWidth: 20,
      appHeight: 6,
      rootPaddingX: 0,
      topChromeRows: 6,
      workspaceRows: 0,
      promptRows: 5,
      topChrome: React.createElement(Text, null, "chrome"),
      chatPanel: null,
      tasksDrawer: null,
      activityBar: null,
      taskGapRows: 0,
      activityGapRows: 0,
      promptInput: React.createElement(PromptInput, {
        active: false,
        focused: false,
        promptTopY: 1,
        widths: {
          terminalWidth: 20,
          rootPaddingX: 0,
          contentWidth: 20,
          inputValueWidth: 10,
        },
        cwd: "/x",
        onSubmit: () => {},
        onExit: () => {},
        onFocus: () => {},
        onBlur: () => {},
      }),
    }),
    { columns: 20 },
  );

  const lines = output.split("\n");
  assert.equal(lines.at(-4), "┌──────────────────┐");
  assert.match(lines.at(-3) ?? "", /Ask Scout/);
});
