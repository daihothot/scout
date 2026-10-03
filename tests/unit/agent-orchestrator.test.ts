import assert from "node:assert/strict";
import test from "node:test";
import { AgentEvents } from "../../src/agent/events/index.js";
import { AgentOrchestrator } from "../../src/agent/orchestration/agent-orchestrator.js";
import { AgentTaskStatuses } from "../../src/agent/task/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("AgentOrchestrator owns its lifecycle and consumes task events", async (t) => {
  const eventBus = new InMemoryEventBus();
  const scope = await installTestRunScope(t, { runId: "agent-orchestrator", eventBus });
  const orchestrator = new AgentOrchestrator();
  t.after(() => orchestrator.stop());
  assert.notEqual(orchestrator.taskStore, scope.agentOrchestrator.taskStore);
  assert.notEqual(orchestrator.stepStore, scope.agentOrchestrator.stepStore);
  assert.notEqual(orchestrator.humanInputStore, scope.agentOrchestrator.humanInputStore);
  assert.notEqual(orchestrator.toolCallStore, scope.agentOrchestrator.toolCallStore);

  assert.deepEqual(orchestrator.snapshot(), {
    started: false,
    stopped: false,
    pendingEventCount: 0,
  });

  orchestrator.start();
  orchestrator.start();
  const request = {
    requestId: "request-1", stepId: "step-1", taskId: "task-1", agentId: "researcher",
    body: "Confirm target", requestedAt: "2026-07-14T00:00:00.000Z",
    message: { messageId: "request-message-1", agentId: "coordinator", body: "Confirm target", queuedAt: "2026-07-14T00:00:00.000Z" },
  };
  await eventBus.publishAndWait(AgentEvents.humanInput.requested, request);
  // Step projection must use this owner's peer Store, not the other installed owner.
  scope.agentOrchestrator.humanInputStore.restore([]);
  orchestrator.stepStore.addStep({
    stepId: "consuming-step", agentId: "coordinator", status: "running", prompt: "Confirm target",
    toolCallIds: [], humanInputReferences: [],
    startedAt: request.requestedAt, updatedAt: request.requestedAt,
  });
  await eventBus.publishAndWait(AgentEvents.message.consumed, {
    messageId: request.message.messageId, agentId: "coordinator", stepId: "consuming-step",
    consumedAt: "2026-07-14T00:00:01.000Z", deliveryMode: "queued",
  });
  assert.deepEqual(orchestrator.stepStore.getStep("consuming-step")?.humanInputReferences, [{
    requestId: request.requestId, kind: "request_consumed",
  }]);
  await eventBus.publishAndWait(AgentEvents.task.assigned, {
    type: "local_agent",
    taskId: "researcher-task-0001",
    taskSequence: 1,
    agentId: "researcher",
    role: "researcher",
    description: "Research BDD",
    initialPrompt: "Research BDD",
    status: AgentTaskStatuses.Queued,
    isBackgrounded: true,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(orchestrator.snapshot(), {
    started: true,
    stopped: false,
    pendingEventCount: 0,
  });

  orchestrator.stop();
  assert.deepEqual(orchestrator.snapshot(), {
    started: true,
    stopped: true,
    pendingEventCount: 0,
  });
  assert.throws(() => orchestrator.start(), /Cannot restart a stopped AgentOrchestrator/);
  await eventBus.publishAndWait(AgentEvents.humanInput.requested, {
    ...request, requestId: "request-2", message: { ...request.message, messageId: "request-message-2" },
  });
  assert.equal(orchestrator.humanInputStore.listForTask("task-1").length, 1);
});
