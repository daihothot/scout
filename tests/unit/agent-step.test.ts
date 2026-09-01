import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AgentToolCallBackend } from "../../src/agent/backend/agent-tool-call-backend.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import {
  AgentStepStore,
  type AgentStepState,
} from "../../src/agent/step/index.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";
import type { ScoutAgent } from "../../src/agent/core/scout-agent.js";

function step(input: Partial<AgentStepState> = {}): AgentStepState {
  return {
    stepId: "researcher-step-0001",
    agentId: "researcher",
    taskId: "researcher-task-0001",
    status: "running",
    prompt: "inspect",
    toolCallIds: [],
    humanInputReferences: [],
    startedAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...input,
  };
}

test("AgentStepStore owns Step facts and returns detached updates", () => {
  const store = new AgentStepStore();
  store.addStep(step());
  const updated = store.updateStep(step().stepId, (current) => ({
    ...current,
    turnId: "turn-1",
    toolCallIds: ["call-1"],
    updatedAt: "2026-08-20T00:00:01.000Z",
  }));
  assert.equal(updated.turnId, "turn-1");
  assert.equal(updated.toolCallIds[0], "call-1");

  updated.toolCallIds.push("mutated");
  assert.equal(store.getStep(step().stepId)?.toolCallIds.length, 1);
});

test("AgentStepStore returns detached snapshots", () => {
  const store = new AgentStepStore();
  store.addStep(step());
  const snapshot = store.getStep(step().stepId)!;
  snapshot.toolCallIds.push("mutated");
  assert.equal(store.getStep(step().stepId)?.toolCallIds.length, 0);
});

test("AgentStepStore restores one step without clearing other agents", () => {
  const store = new AgentStepStore();
  store.addStep(step());
  const coordinatorStep: AgentStepState = {
    ...step(),
    stepId: "coordinator-step-0001",
    agentId: "coordinator",
    taskId: undefined,
  };
  store.restoreStep(coordinatorStep);
  assert.deepEqual(
    store.list().map((candidate) => candidate.stepId).sort(),
    ["coordinator-step-0001", "researcher-step-0001"],
  );
  const restored = store.restoreStep(coordinatorStep);
  assert.equal(restored.stepId, coordinatorStep.stepId);
  assert.equal(restored.agentId, coordinatorStep.agentId);
  assert.equal(restored.status, coordinatorStep.status);
  assert.equal(restored.prompt, coordinatorStep.prompt);
  assert.throws(() => store.restoreStep({
    ...coordinatorStep,
    agentId: "validator",
  }));
});

test("Tool Call backend owns provider facts and Step stores only their ids", async (t) => {
  const eventBus = new InMemoryEventBus();
  const scope = installTestRunScope(t, {
    runId: "tool-call-facts",
    eventBus,
  });
  const running = step({ stepId: "tool-step", turnId: "turn-1" });
  scope.stepStore.addStep(running);
  const toolCallBackend = new AgentToolCallBackend();

  const agent = { agentId: "researcher" } as ScoutAgent;
  const entry = {
    seq: 4,
    receivedAt: "2026-08-20T00:00:01.000Z",
    stream: "item" as const,
    kind: "item_completed",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-tool-1",
  };
  const item = {
    id: "item-tool-1",
    type: "dynamicToolCall" as const,
    namespace: "scout",
    tool: "Inspect",
    arguments: { path: "artifact" },
    status: "completed" as const,
    contentItems: [{ type: "text", text: "ok" }],
    success: true,
  };
  toolCallBackend.handleAppServerTimelineEntry(agent, entry, {
    entry,
    item,
  });
  toolCallBackend.handleAppServerTimelineEntry(agent, {
    ...entry,
    seq: 3,
    kind: "item_started",
    receivedAt: "2026-08-20T00:00:00.000Z",
  }, {
    entry,
    item: { ...item, status: "inProgress", success: null },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const calls = scope.toolCallStore.list({ stepId: running.stepId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.toolCallId, "item-tool-1");
  assert.equal(calls[0]?.status, "completed");
  assert.deepEqual(scope.stepStore.getStep(running.stepId)?.toolCallIds, ["item-tool-1"]);
});

test("Step lifecycle snapshots retain references that arrive before Step creation", async (t) => {
  const eventBus = new InMemoryEventBus();
  const scope = installTestRunScope(t, {
    runId: "step-pending-references",
    eventBus,
  });
  const stepId = "pending-step";
  const request = {
    requestId: "pending-request",
    stepId,
    taskId: "researcher-task-0001",
    agentId: "researcher",
    body: "Choose an account.",
    requestedAt: "2026-08-20T00:00:01.000Z",
    message: {
      messageId: "pending-request-message",
      agentId: "coordinator",
      body: "Choose an account.",
      queuedAt: "2026-08-20T00:00:01.000Z",
    },
  };
  const call = {
    toolCallId: "pending-call",
    kind: "dynamic" as const,
    agentId: "researcher",
    taskId: "researcher-task-0001",
    stepId,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "pending-call",
    namespace: "scout",
    tool: "Inspect",
    arguments: { path: "artifact" },
    status: "completed",
    success: true,
    sourceSeq: 4,
    observedAt: "2026-08-20T00:00:02.000Z",
  };
  await eventBus.publishAndWait(AgentEvents.humanInput.requested, request);
  await eventBus.publishAndWait(AgentEvents.toolCall.observed, call);
  const startedEvents: AgentStepState[] = [];
  eventBus.subscribe(AgentEvents.step.started, (event) => {
    if (AgentEvents.step.started.is(event)) startedEvents.push(event.payload);
  });

  const started = scope.stepStore.startStep(step({ stepId, turnId: "turn-1" }));
  assert.deepEqual(started.toolCallIds, ["pending-call"]);
  assert.deepEqual(started.humanInputReferences, [{
    requestId: "pending-request",
    kind: "request_produced",
  }]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(scope.stepStore.getStep(stepId), started);
  assert.deepEqual(startedEvents, [started]);
});

test("AgentStepStore records one durable Step reference for every Human Input edge", async (t) => {
  const eventBus = new InMemoryEventBus();
  const scope = installTestRunScope(t, {
    runId: "step-human-input-references",
    eventBus,
  });
  const steps = [
    step({ stepId: "worker-request-step" }),
    step({ stepId: "coordinator-request-step", agentId: "coordinator", taskId: undefined }),
    step({ stepId: "coordinator-response-step", agentId: "coordinator", taskId: undefined }),
    step({ stepId: "worker-response-step" }),
  ];
  for (const current of steps) scope.stepStore.addStep(current);
  const request = {
    requestId: "request-1",
    stepId: "worker-request-step",
    taskId: "researcher-task-0001",
    agentId: "researcher",
    body: "Choose an account.",
    requestedAt: "2026-08-20T00:00:01.000Z",
    message: {
      messageId: "request-1-message",
      agentId: "coordinator",
      body: "Choose an account.",
      queuedAt: "2026-08-20T00:00:01.000Z",
    },
  };
  await eventBus.publishAndWait(AgentEvents.humanInput.requested, request);
  await eventBus.publishAndWait(AgentEvents.humanInput.requested, request);
  await eventBus.publishAndWait(AgentEvents.message.consumed, {
    messageId: request.message.messageId,
    agentId: "coordinator",
    stepId: "coordinator-request-step",
    consumedAt: "2026-08-20T00:00:02.000Z",
    deliveryMode: "queued",
  });
  const response = {
    requestId: request.requestId,
    stepId: "coordinator-response-step",
    taskId: request.taskId,
    agentId: request.agentId,
    body: "Use staging.",
    respondedAt: "2026-08-20T00:00:03.000Z",
    message: {
      messageId: "request-1-response",
      agentId: "researcher",
      taskId: request.taskId,
      body: "Use staging.",
      queuedAt: "2026-08-20T00:00:03.000Z",
    },
  };
  await eventBus.publishAndWait(AgentEvents.humanInput.responded, response);
  await eventBus.publishAndWait(AgentEvents.message.consumed, {
    messageId: response.message.messageId,
    agentId: "researcher",
    stepId: "worker-response-step",
    taskId: request.taskId,
    consumedAt: "2026-08-20T00:00:04.000Z",
    deliveryMode: "steer",
    turnId: "worker-response-turn",
  });

  assert.deepEqual(scope.stepStore.getStep("worker-request-step")?.humanInputReferences, [{
    requestId: request.requestId,
    kind: "request_produced",
  }]);
  assert.deepEqual(scope.stepStore.getStep("coordinator-request-step")?.humanInputReferences, [{
    requestId: request.requestId,
    kind: "request_consumed",
  }]);
  assert.deepEqual(scope.stepStore.getStep("coordinator-response-step")?.humanInputReferences, [{
    requestId: request.requestId,
    kind: "response_produced",
  }]);
  assert.deepEqual(scope.stepStore.getStep("worker-response-step")?.humanInputReferences, [{
    requestId: request.requestId,
    kind: "response_consumed",
  }]);
});

test("Agent runners do not depend on AgentStepBackend", () => {
  const runnerSources = [
    "src/agent/runner/agent-runner.ts",
    "src/agent/runner/coordinator/coordinator-runner.ts",
    "src/agent/runner/task/task-runner.ts",
    "src/agent/runner/worker/worker-runner.ts",
  ];
  for (const sourcePath of runnerSources) {
    const source = readFileSync(join(process.cwd(), sourcePath), "utf8");
    assert.doesNotMatch(source, /AgentStepBackend|agent-step-backend|stepBackend/);
  }
});

test("WorkerRunner owns Step facts while TaskRunner owns Task facts", () => {
  const workerSource = readFileSync(
    join(process.cwd(), "src/agent/runner/worker/worker-runner.ts"),
    "utf8",
  );
  const taskSource = readFileSync(
    join(process.cwd(), "src/agent/runner/task/task-runner.ts"),
    "utf8",
  );

  assert.doesNotMatch(workerSource, /AgentEvents\.task|taskStore|AgentTaskDisposition|AgentTaskStatus/);
  assert.doesNotMatch(taskSource, /AgentEvents\.step|stepStore\.(?:add|update)|\.(?:start|complete|interrupt|fail)Step\(/);
  assert.doesNotMatch(taskSource, /WorkerRunner|worker-runner/);
});
