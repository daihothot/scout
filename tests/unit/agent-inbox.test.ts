import test from "node:test";
import assert from "node:assert/strict";
import { AgentInbox } from "../../src/agent/core/agent-inbox.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";

test("AgentInbox drains subscribed events until idle", async () => {
  const bus = new InMemoryEventBus();
  const received: string[] = [];
  const inbox = new AgentInbox({
    eventBus: bus,
    isStopped: () => false,
    onEvents: async (events) => {
      received.push(...events.map((event) => event.key.routeKey));
    },
    onError: (error) => assert.fail(String(error)),
  });

  inbox.subscribe(AgentEvents.task);
  bus.publish(AgentEvents.task.assigned, { taskId: "task-1" });
  bus.publish(AgentEvents.task.messageQueued, { taskId: "task-1" });

  await inbox.runToIdle();

  assert.deepEqual(received, [
    AgentEvents.task.assigned.routeKey,
    AgentEvents.task.messageQueued.routeKey,
  ]);
  assert.equal(inbox.size, 0);
  assert.equal(inbox.isRunning(), false);
});

test("AgentInbox reports errors and continues when events remain", async () => {
  const bus = new InMemoryEventBus();
  const errors: unknown[] = [];
  const taskIds: string[] = [];
  let batches = 0;
  const inbox = new AgentInbox({
    eventBus: bus,
    isStopped: () => false,
    onEvents: async (events) => {
      batches += 1;
      taskIds.push(...events.map((event) => (event.payload as { taskId: string }).taskId));
      if (batches === 1) {
        bus.publish(AgentEvents.task.messageQueued, { taskId: "task-2" });
        throw new Error("boom");
      }
    },
    onError: (error) => errors.push(error),
  });

  inbox.subscribe(AgentEvents.task);
  bus.publish(AgentEvents.task.assigned, { taskId: "task-1" });

  await inbox.runToIdle();

  assert.equal(batches, 2);
  assert.deepEqual(taskIds, ["task-1", "task-2"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /boom/);
});

test("AgentInbox handles events published while draining", async () => {
  const bus = new InMemoryEventBus();
  const taskIds: string[] = [];
  let batches = 0;
  const inbox = new AgentInbox({
    eventBus: bus,
    isStopped: () => false,
    onEvents: async (events) => {
      batches += 1;
      taskIds.push(...events.map((event) => (event.payload as { taskId: string }).taskId));
      if (batches === 1) {
        queueMicrotask(() => {
          bus.publish(AgentEvents.task.messageQueued, { taskId: "task-2" });
        });
      }
    },
    onError: (error) => assert.fail(String(error)),
  });

  inbox.subscribe(AgentEvents.task);
  bus.publish(AgentEvents.task.assigned, { taskId: "task-1" });

  await new Promise((resolve) => setImmediate(resolve));
  await inbox.runToIdle();

  assert.deepEqual(taskIds, ["task-1", "task-2"]);
  assert.equal(inbox.size, 0);
});

test("AgentInbox stops receiving and draining events", async () => {
  const bus = new InMemoryEventBus();
  let batches = 0;
  const inbox = new AgentInbox({
    eventBus: bus,
    isStopped: () => false,
    onEvents: async () => {
      batches += 1;
    },
    onError: (error) => assert.fail(String(error)),
  });

  inbox.subscribe(AgentEvents.task);
  inbox.stop();
  bus.publish(AgentEvents.task.assigned, { taskId: "task-1" });

  await inbox.runToIdle();

  assert.equal(batches, 0);
  assert.equal(inbox.size, 0);
  assert.throws(() => {
    inbox.subscribe(AgentEvents.task);
  }, /stopped event mailbox/);
});
