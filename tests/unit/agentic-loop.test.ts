import test from "node:test";
import assert from "node:assert/strict";
import { AgenticLoop } from "../../src/agent/core/agentic-loop.js";

test("AgenticLoop runs pending work until idle", async () => {
  const pending = [1, 2, 3];
  let steps = 0;
  const loop = new AgenticLoop<number>({
    agentId: "worker",
    handlers: {
      takeStep: () => pending.shift(),
      runStep: async () => {
        steps += 1;
      },
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
  const pending = [1, 2];
  let steps = 0;
  const errors: unknown[] = [];
  const loop = new AgenticLoop<number>({
    agentId: "worker",
    handlers: {
      takeStep: () => pending.shift(),
      runStep: async () => {
        steps += 1;
        if (steps === 1) throw new Error("boom");
      },
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
  const pending = [1];
  let stopped = false;
  let steps = 0;
  const loop = new AgenticLoop<number>({
    agentId: "worker",
    handlers: {
      takeStep: () => pending.shift(),
      runStep: async () => {
        steps += 1;
        if (steps === 1) {
          queueMicrotask(() => {
            pending.push(2);
          });
        } else {
          stopped = true;
        }
      },
      isStopped: () => stopped,
      onError: () => undefined,
    },
  });

  loop.schedule();
  await new Promise((resolve) => setImmediate(resolve));
  await loop.runToIdle();

  assert.equal(steps, 2);
});

test("AgenticLoop does not run a step when no step can be taken", async () => {
  let steps = 0;
  const loop = new AgenticLoop<number>({
    agentId: "worker",
    handlers: {
      takeStep: () => undefined,
      runStep: async () => {
        steps += 1;
      },
      isStopped: () => false,
      onError: () => undefined,
    },
  });

  loop.schedule();
  await loop.runToIdle();

  assert.equal(steps, 0);
  assert.equal(loop.isRunning(), false);
});
