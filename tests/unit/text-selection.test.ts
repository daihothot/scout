import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTuiSelectionSegments,
  extractTuiSelectionText,
  normalizeTuiSelection,
  sliceByDisplayCells,
  writeTuiClipboard,
} from "../../src/interaction/tui/text-selection.js";

test("TUI selection normalizes reverse drags and extracts inclusive endpoints", () => {
  const selection = {
    anchor: { x: 3, y: 4 },
    focus: { x: 1, y: 2 },
  };
  assert.deepEqual(normalizeTuiSelection(selection), {
    start: { x: 1, y: 2 },
    end: { x: 3, y: 4 },
  });
  assert.equal(extractTuiSelectionText([
    { y: 2, text: "alpha" },
    { y: 3, text: "middle" },
    { y: 4, text: "omega" },
  ], selection), "lpha\nmiddle\nomeg");
});

test("TUI selection preserves blank screen rows between selectable regions", () => {
  assert.equal(extractTuiSelectionText([
    { y: 2, text: "first" },
    { y: 4, text: "last" },
  ], {
    anchor: { x: 2, y: 2 },
    focus: { x: 1, y: 4 },
  }), "rst\n\nla");
});

test("TUI selection keeps wide characters intact at cell boundaries", () => {
  assert.equal(sliceByDisplayCells("A中文B", 2, 4), "中文");
  assert.deepEqual(buildTuiSelectionSegments([
    { y: 7, text: "A中文B" },
  ], {
    anchor: { x: 2, y: 7 },
    focus: { x: 4, y: 7 },
  }), [{ y: 7, startX: 1, text: "中文" }]);
});

test("TUI clipboard emits a UTF-8 OSC 52 payload", () => {
  const writes: string[] = [];
  writeTuiClipboard({ write: (value) => writes.push(value) }, "复制 me");
  assert.deepEqual(writes, [
    `\u001b]52;c;${Buffer.from("复制 me", "utf8").toString("base64")}\u0007`,
  ]);
});
