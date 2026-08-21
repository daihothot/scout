import assert from "node:assert/strict";
import test from "node:test";
import { AgentEvents } from "../../src/agent/events/index.js";
import {
  EventSubscriptionPriorities,
  InMemoryEventBus,
} from "../../src/core/events/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("AgentHumanInputStore projects requests and matching responses", async (t) => {
  const eventBus = new InMemoryEventBus();
  const store = installTestRunScope(t, {
    runId: "human-input-projection",
    eventBus,
  }).humanInputStore;
  const request = {
    requestId: "task-1-human-1",
    stepId: "task-1-step-request",
    taskId: "task-1",
    agentId: "researcher",
    body: "请确认目标版本。",
    requestedAt: "2026-07-23T00:00:00.000Z",
    message: {
      messageId: "task-1-human-1-request",
      agentId: "coordinator",
      body: "<wait-for-human-request>\n请确认目标版本。\n</wait-for-human-request>",
      queuedAt: "2026-07-23T00:00:00.000Z",
    },
  };

  await eventBus.publishAndWait(AgentEvents.humanInput.requested, request);
  assert.deepEqual(store.listForTask("task-1"), [request]);

  const requestConsumption = {
    messageId: request.message.messageId,
    agentId: request.message.agentId,
    stepId: "coordinator-step-request",
    consumedAt: "2026-07-23T00:00:01.000Z",
    deliveryMode: "queued" as const,
  };
  await eventBus.publishAndWait(AgentEvents.message.consumed, requestConsumption);

  const response = {
    requestId: request.requestId,
    stepId: "coordinator-step-response",
    taskId: request.taskId,
    agentId: request.agentId,
    body: "使用 v2。",
    respondedAt: "2026-07-23T00:01:00.000Z",
    message: {
      messageId: "task-1-human-1-response",
      agentId: "researcher",
      taskId: "task-1",
      body: "<human-response>\n使用 v2。\n</human-response>",
      queuedAt: "2026-07-23T00:01:00.000Z",
    },
  };
  await eventBus.publishAndWait(AgentEvents.humanInput.responded, response);
  const responseConsumption = {
    messageId: response.message.messageId,
    agentId: response.message.agentId,
    stepId: "task-1-step-response",
    taskId: response.taskId,
    consumedAt: "2026-07-23T00:01:01.000Z",
    deliveryMode: "queued" as const,
  };
  await eventBus.publishAndWait(AgentEvents.message.consumed, responseConsumption);

  assert.deepEqual(store.listForTask("task-1"), [{
    ...request,
    requestConsumption,
    response: {
      stepId: response.stepId,
      body: response.body,
      respondedAt: response.respondedAt,
      message: response.message,
      consumption: responseConsumption,
    },
  }]);

  await assert.rejects(
    eventBus.publishAndWait(AgentEvents.message.consumed, requestConsumption),
    /Human input request .* was consumed more than once/,
  );
  await assert.rejects(
    eventBus.publishAndWait(AgentEvents.message.consumed, responseConsumption),
    /Human input response .* was consumed more than once/,
  );
});

test("AgentHumanInputStore restores a cloned projection", (t) => {
  const store = installTestRunScope(t, {
    runId: "human-input-restore",
  }).humanInputStore;
  const state = {
    requestId: "task-1-human-1",
    stepId: "task-1-step-1",
    taskId: "task-1",
    agentId: "researcher",
    body: "请确认目标版本。",
    requestedAt: "2026-07-23T00:00:00.000Z",
    message: {
      messageId: "task-1-human-1-request",
      agentId: "coordinator",
      body: "request",
      queuedAt: "2026-07-23T00:00:00.000Z",
    },
  };

  store.restore([state]);
  state.body = "外部修改";

  assert.equal(store.listForTask("task-1")[0]?.body, "请确认目标版本。");
});

test("AgentHumanInputStore does not project an event when persistence fails", async (t) => {
  const eventBus = new InMemoryEventBus();
  const store = installTestRunScope(t, {
    runId: "human-input-persistence-failure",
    eventBus,
  }).humanInputStore;
  eventBus.subscribe(AgentEvents.humanInput.requested, () => {
    throw new Error("journal write failed");
  }, {
    priority: EventSubscriptionPriorities.High,
  });

  await assert.rejects(
    eventBus.publishAndWait(AgentEvents.humanInput.requested, {
      requestId: "task-1-human-1",
      stepId: "task-1-step-1",
      taskId: "task-1",
      agentId: "researcher",
      body: "请确认目标版本。",
      requestedAt: "2026-07-23T00:00:00.000Z",
      message: {
        messageId: "task-1-human-1-request",
        agentId: "coordinator",
        body: "request",
        queuedAt: "2026-07-23T00:00:00.000Z",
      },
    }),
    /journal write failed/,
  );
  assert.deepEqual(store.listForTask("task-1"), []);
});
