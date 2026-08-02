import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePromptPaste,
  reducePromptInput,
} from "../../src/interaction/tui/chrome/prompt-input-state.js";

test("prompt input preserves a long replacement split after Ctrl+U", () => {
  const replacement = `begin-${"x".repeat(1_500)}-end`;
  const firstChunk = `\u0015${replacement.slice(0, 1_000)}`;
  const secondChunk = replacement.slice(1_000);

  const first = reducePromptInput("stale input", firstChunk);
  const second = reducePromptInput(first.value, secondChunk);

  assert.equal(first.submissions.length, 0);
  assert.equal(second.value, replacement);
  assert.equal(second.submissions.length, 0);
});

test("prompt input submits text when return shares the same input chunk", () => {
  const transition = reducePromptInput("", "complete response\r");

  assert.equal(transition.value, "");
  assert.deepEqual(transition.submissions, ["complete response"]);
  assert.equal(transition.exitRequested, false);
});

test("prompt input handles controls without dropping printable neighbors", () => {
  const transition = reducePromptInput("old", "\u0015new\u0000 value\u0008e");

  assert.equal(transition.value, "new value");
  assert.deepEqual(transition.submissions, []);
});

test("prompt paste keeps long text and flattens multiline controls", () => {
  const longLine = "a".repeat(2_000);
  const pasted = normalizePromptPaste(`${longLine}\r\nsecond\tcolumn\u0000`);

  assert.equal(pasted, `${longLine} second column`);
  assert.equal(reducePromptInput("prefix ", pasted).value, `prefix ${longLine} second column`);
});

test("prompt input recognizes exit after chunk processing", () => {
  const transition = reducePromptInput("", "/exit\r");

  assert.equal(transition.value, "");
  assert.deepEqual(transition.submissions, []);
  assert.equal(transition.exitRequested, true);
});
