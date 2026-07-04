import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryEventBus,
  EventMailbox,
  createEventKeyFactory,
  defineEventCatalog,
  event,
} from "../../src/core/events/index.js";
import { AgentEvents } from "../../src/agent/events/index.js";

test("event key factory builds scope/group/name route keys and rejects duplicates", () => {
  const factory = createEventKeyFactory();
  const key = factory.define({
    scope: "domain.validation",
    group: "task",
    name: "state_changed",
    tag: "snapshot",
  });

  assert.equal(key.routeKey, "domain.validation.task.state_changed.snapshot");
  assert.equal(factory.build({
    scope: "domain.validation",
    group: "task",
    name: "state_changed",
    tag: "snapshot",
  }), key.routeKey);
  assert.throws(() => factory.define({
    scope: "domain.validation",
    group: "task",
    name: "state_changed",
    tag: "snapshot",
  }), /Duplicate event key/);
});

test("event key factory rejects task and turn identifiers as key-like invalid parts", () => {
  const factory = createEventKeyFactory();

  assert.throws(() => factory.define({
    scope: "domain.validation",
    group: "task-1",
    name: "raised",
  }), /Invalid event key group/);
  assert.throws(() => factory.define({
    scope: "system",
    group: "task",
    name: "turn.1",
  }), /Invalid event key name/);
});

test("event catalog infers scope group and name from object path", () => {
  const catalog = defineEventCatalog("domain.validation", {
    bdd: {
      factReceived: event<{ bddId: string }>(),
    },
  });

  assert.equal(catalog.bdd.factReceived.scope, "domain.validation");
  assert.equal(catalog.bdd.scope, "domain.validation");
  assert.equal(catalog.bdd.group, "bdd");
  assert.equal(catalog.bdd.routePrefix, "domain.validation.bdd.");
  assert.equal(catalog.bdd.factReceived.group, "bdd");
  assert.equal(catalog.bdd.factReceived.name, "fact_received");
  assert.equal(catalog.bdd.factReceived.routeKey, "domain.validation.bdd.fact_received");
});

test("event bus subscribes to an event catalog group", () => {
  const bus = new InMemoryEventBus();
  const received: string[] = [];

  bus.subscribe(AgentEvents.task, (event) => {
    received.push(event.key.routeKey);
  });
  bus.publish(AgentEvents.task.assigned, { taskId: "task-1" });
  bus.publish(AgentEvents.task.messageQueued, { taskId: "task-1" });
  bus.publish(AgentEvents.interrupt.raised, { interruptKind: "human_input" });

  assert.deepEqual(received, [
    "agent.task.assigned",
    "agent.task.message_queued",
  ]);
});

test("event bus exact and group subscribers both receive matching events", () => {
  const bus = new InMemoryEventBus();
  const received: string[] = [];

  bus.subscribe(AgentEvents.task, () => {
    received.push("group");
  });
  bus.subscribe(AgentEvents.task.assigned, () => {
    received.push("exact");
  });
  bus.publish(AgentEvents.task.assigned, { taskId: "task-1" });

  assert.deepEqual(received, ["exact", "group"]);
});

test("event bus subscribeOnce works for event groups", () => {
  const bus = new InMemoryEventBus();
  let count = 0;

  bus.subscribeOnce(AgentEvents.task, () => {
    count += 1;
  });
  bus.publish(AgentEvents.task.assigned, { taskId: "task-1" });
  bus.publish(AgentEvents.task.messageQueued, { taskId: "task-1" });

  assert.equal(count, 1);
});

test("event bus publishes to continuous subscribers by route key", () => {
  const bus = new InMemoryEventBus();
  const received: string[] = [];

  bus.subscribe<{ taskId: string }>(AgentEvents.task.messageQueued, (event) => {
    received.push(`${event.key.routeKey}:${event.payload.taskId}`);
  });
  bus.publish(AgentEvents.task.messageQueued, { taskId: "task-1" });
  bus.publish(AgentEvents.task.messageQueued, { taskId: "task-2" });

  assert.deepEqual(received, [
    "agent.task.message_queued:task-1",
    "agent.task.message_queued:task-2",
  ]);
});

test("event bus subscribeOnce removes handler after first delivery", () => {
  const bus = new InMemoryEventBus();
  let count = 0;

  bus.subscribeOnce(AgentEvents.interrupt.raised, () => {
    count += 1;
  });
  bus.publish(AgentEvents.interrupt.raised, { interruptKind: "human_input" });
  bus.publish(AgentEvents.interrupt.raised, { interruptKind: "exception" });

  assert.equal(count, 1);
});

test("event bus publish does not await async handlers", async () => {
  const bus = new InMemoryEventBus();
  let completed = false;

  bus.subscribe(AgentEvents.task.assigned, async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    completed = true;
  });
  bus.publish(AgentEvents.task.assigned, { taskId: "task-1" });

  assert.equal(completed, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(completed, true);
});

test("event bus publishAndWait awaits async handlers", async () => {
  const bus = new InMemoryEventBus();
  let completed = false;

  bus.subscribe(AgentEvents.task.assigned, async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    completed = true;
  });
  await bus.publishAndWait(AgentEvents.task.assigned, { taskId: "task-1" });

  assert.equal(completed, true);
});

test("event mailbox filters subscribed events before enqueueing", () => {
  const bus = new InMemoryEventBus();
  const mailbox = new EventMailbox({ eventBus: bus });

  mailbox.subscribe<{ taskId: string }>(AgentEvents.task, {
    filter: (event) => event.payload.taskId === "task-2",
  });

  bus.publish(AgentEvents.task.assigned, { taskId: "task-1" });
  bus.publish(AgentEvents.task.messageQueued, { taskId: "task-2" });

  const events = mailbox.drain();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.key.routeKey, AgentEvents.task.messageQueued.routeKey);
  assert.deepEqual(events[0]?.payload, { taskId: "task-2" });
});

test("event mailbox keeps concurrent published events without dropping them", async () => {
  const bus = new InMemoryEventBus();
  const mailbox = new EventMailbox({ eventBus: bus });

  mailbox.subscribe<{ taskId: string }>(AgentEvents.task);

  await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    await new Promise((resolve) => setTimeout(resolve, index % 3));
    bus.publish(AgentEvents.task.messageQueued, { taskId: `task-${index}` });
  }));

  const taskIds = mailbox.drain()
    .map((event) => (event.payload as { taskId: string }).taskId)
    .sort();
  assert.deepEqual(taskIds, Array.from({ length: 20 }, (_, index) => `task-${index}`).sort());
  assert.equal(mailbox.hasEvents(), false);
});
