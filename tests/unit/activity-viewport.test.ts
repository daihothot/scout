import assert from "node:assert/strict";
import test from "node:test";
import {
  mouseWheelDelta,
  parseSgrMouseEvent,
  resolveActivityScrollTop,
  scrollActivity,
} from "../../src/interaction/tui/activity-viewport.js";

test("activity viewport follows the tail until the user scrolls away", () => {
  assert.equal(resolveActivityScrollTop(20, 5, null), 15);
  assert.equal(scrollActivity(20, 5, null, -1), 14);
  assert.equal(scrollActivity(20, 5, 14, 1), null);
});

test("activity viewport clamps keyboard and page scrolling", () => {
  assert.equal(scrollActivity(20, 5, 4, -10), 0);
  assert.equal(scrollActivity(20, 5, 4, 5), 9);
  assert.equal(scrollActivity(20, 5, 14, 10), null);
  assert.equal(resolveActivityScrollTop(3, 5, 99), 0);
});

test("activity viewport parses SGR mouse wheel input", () => {
  const wheelUp = parseSgrMouseEvent("[<64;12;15M");
  const wheelDown = parseSgrMouseEvent("\u001b[<65;12;21M");
  const primaryDrag = parseSgrMouseEvent("\u001b[<32;18;9M");

  assert.deepEqual(wheelUp, {
    button: 64,
    x: 12,
    y: 15,
    released: false,
  });
  assert.equal(mouseWheelDelta(wheelUp!), -3);
  assert.equal(mouseWheelDelta(wheelDown!), 3);
  assert.deepEqual(primaryDrag, {
    button: 32,
    x: 18,
    y: 9,
    released: false,
  });
  assert.equal(parseSgrMouseEvent("not-mouse-input"), undefined);
});
