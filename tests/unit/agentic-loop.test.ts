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

test("AgenticLoop schedules delayed tick continuation", async () => {
  const pending = [1];
  const ticks: number[] = [];
  let stopped = false;
  const loop = new AgenticLoop<number>({
    agentId: "worker",
    takeTick: () => pending.shift(),
    runTick: async (tick) => {
      ticks.push(tick);
      if (ticks.length === 1) return { continueAfterMs: 1 };
      stopped = true;
      return undefined;
    },
    isStopped: () => stopped,
    onError: () => undefined,
  });

  loop.schedule();
  await waitFor(() => ticks.length >= 2);

  assert.deepEqual(ticks, [1, 1]);
});

test("AgenticLoop lets immediate tick work replace delayed continuation", async () => {
  const pending = [1];
  const ticks: number[] = [];
  let stopped = false;
  const loop = new AgenticLoop<number>({
    agentId: "worker",
    takeTick: () => pending.shift(),
    runTick: async (tick) => {
      ticks.push(tick);
      if (tick === 1) return { continueAfterMs: 50 };
      stopped = true;
      return undefined;
    },
    isStopped: () => stopped,
    onError: () => undefined,
  });

  loop.schedule();
  await waitFor(() => ticks.length === 1);
  pending.push(2);
  loop.schedule();
  await waitFor(() => ticks.length >= 2);

  assert.deepEqual(ticks, [1, 2]);
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

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("Timed out waiting for condition.");
}
