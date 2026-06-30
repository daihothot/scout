import test from "node:test";
import assert from "node:assert/strict";
import { AgenticLoop } from "../../src/agent/core/agentic-loop.js";

test("AgenticLoop runs pending work until idle", async () => {
  let pending = 3;
  let steps = 0;
  const loop = new AgenticLoop({
    agentId: "worker",
    handlers: {
      runStep: async () => {
        steps += 1;
        pending -= 1;
      },
      hasPendingWork: () => pending > 0,
      isStopped: () => false,
      onError: () => undefined,
    },
  });

  loop.schedule();
  assert.equal(loop.isRunning(), true);
  await loop.runToIdle();

  assert.equal(steps, 3);
  assert.equal(loop.isRunning(), false);
});

test("AgenticLoop reports step errors and continues when work remains", async () => {
  let pending = 2;
  let steps = 0;
  const errors: unknown[] = [];
  const loop = new AgenticLoop({
    agentId: "worker",
    handlers: {
      runStep: async () => {
        steps += 1;
        pending -= 1;
        if (steps === 1) throw new Error("boom");
      },
      hasPendingWork: () => pending > 0,
      isStopped: () => false,
      onError: (error) => errors.push(error),
    },
  });

  await loop.runToIdle();

  assert.equal(steps, 2);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /boom/);
});

test("AgenticLoop schedules again when new work appears during finally", async () => {
  let pending = 1;
  let stopped = false;
  let steps = 0;
  const loop = new AgenticLoop({
    agentId: "worker",
    handlers: {
      runStep: async () => {
        steps += 1;
        pending -= 1;
        if (steps === 1) {
          queueMicrotask(() => {
            pending += 1;
          });
        } else {
          stopped = true;
        }
      },
      hasPendingWork: () => pending > 0,
      isStopped: () => stopped,
      onError: () => undefined,
    },
  });

  loop.schedule();
  await new Promise((resolve) => setImmediate(resolve));
  await loop.runToIdle();

  assert.equal(steps, 2);
});
