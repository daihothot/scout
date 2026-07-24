import test from "node:test";
import assert from "node:assert/strict";
import { AgenticLoop } from "../../src/agent/core/agentic-loop.js";

test("AgenticLoop runs tick work until idle", async () => {
  const pending = [1, 2, 3];
  let ticks = 0;
  const loop = new AgenticLoop<number>({
    agentId: "worker",
    takeTick: () => pending.shift(),
    runTick: async () => {
      ticks += 1;
    },
    isStopped: () => false,
    onError: () => undefined,
  });

  loop.schedule();
  assert.equal(loop.isRunning(), true);
  await loop.runToIdle();

  assert.equal(ticks, 3);
  assert.equal(loop.isRunning(), false);
});

test("AgenticLoop schedules again when new tick work appears during finally", async () => {
  const pending = [1];
  let stopped = false;
  let ticks = 0;
  const loop = new AgenticLoop<number>({
    agentId: "worker",
    takeTick: () => pending.shift(),
    runTick: async () => {
      ticks += 1;
      if (ticks === 1) {
        queueMicrotask(() => {
          pending.push(2);
        });
      } else {
        stopped = true;
      }
    },
    isStopped: () => stopped,
    onError: () => undefined,
  });

  loop.schedule();
  await new Promise((resolve) => setImmediate(resolve));
  await loop.runToIdle();

  assert.equal(ticks, 2);
});

test("AgenticLoop does not run tick when no tick can be taken", async () => {
  let ticks = 0;
  const loop = new AgenticLoop<number>({
    agentId: "worker",
    takeTick: () => undefined,
    runTick: async () => {
      ticks += 1;
    },
    isStopped: () => false,
    onError: () => undefined,
  });

  loop.schedule();
  await loop.runToIdle();

  assert.equal(ticks, 0);
  assert.equal(loop.isRunning(), false);
});
