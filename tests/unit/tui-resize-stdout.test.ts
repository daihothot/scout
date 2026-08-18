import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createTuiResizeStdout } from "../../src/interaction/tui/run-tui.js";

test("TUI resize stdout skips Ink eager resize and keeps the React listener", () => {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  stdout.isTTY = true;
  const controlled = createTuiResizeStdout(stdout);
  let inkCalls = 0;
  let reactCalls = 0;

  controlled.stdout.on("resize", () => {
    inkCalls += 1;
  });
  controlled.stdout.on("resize", () => {
    reactCalls += 1;
  });

  stdout.emit("resize");
  assert.equal(inkCalls, 0);
  assert.equal(reactCalls, 1);

  controlled.dispose();
  stdout.emit("resize");
  assert.equal(reactCalls, 1);
});
