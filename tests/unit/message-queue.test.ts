import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeMessageQueueManager } from "../../src/core/queue/message-queue.js";

test("RuntimeMessageQueueManager drains by priority and preserves FIFO within priority", () => {
  const queue = new RuntimeMessageQueueManager();

  queue.enqueue({ type: "task_notification", priority: "later", payload: "later-1" });
  queue.enqueue({ type: "system_event", priority: "next", payload: "next-1" });
  queue.enqueue({ type: "user_input", priority: "now", payload: "now-1" });
  queue.enqueue({ type: "system_event", priority: "next", payload: "next-2" });
  queue.enqueue({ type: "user_input", priority: "now", payload: "now-2" });

  assert.deepEqual(queue.drain().map((command) => command.payload), [
    "now-1",
    "now-2",
    "next-1",
    "next-2",
    "later-1",
  ]);
  assert.equal(queue.dequeue(), undefined);
});

test("RuntimeMessageQueueManager applies default priorities", () => {
  const queue = new RuntimeMessageQueueManager();

  const task = queue.enqueue({ type: "task_notification", payload: "task" });
  const user = queue.enqueue({ type: "user_input", payload: "user" });
  const system = queue.enqueue({ type: "system_event", payload: "system" });

  assert.equal(task.priority, "later");
  assert.equal(user.priority, "next");
  assert.equal(system.priority, "next");
});

test("RuntimeMessageQueueManager snapshot is a non-draining copy", () => {
  const queue = new RuntimeMessageQueueManager();
  const command = queue.enqueue({
    type: "task_notification",
    payload: "payload",
    sourceTaskId: "task-1",
  });

  const snapshot = queue.snapshot();
  snapshot.length = 0;

  assert.equal(queue.snapshot().length, 1);
  assert.equal(queue.dequeue()?.id, command.id);
});
