import assert from "node:assert/strict";
import test from "node:test";
import { AgentEvents } from "../../src/agent/events/index.js";
import { AgentOrchestrator } from "../../src/agent/orchestration/agent-orchestrator.js";
import { AuthorizationStage } from "../../src/run/lifecycle/stages/authorization-stage.js";
import { agentPermissionRequestSourceType } from "../../src/core/authorization/request-source/permission/agent-permission-request-source.js";
import { authorizationJournalPaths } from "../../src/core/io/index.js";
import { readJournalEvents } from "../../src/core/journal/index.js";
import { AgentEntityRecovery } from "../../src/agent/orchestration/recovery/agent-entity-recovery.js";
import { AgentTaskRecovery } from "../../src/agent/orchestration/recovery/agent-task-recovery.js";
import { AgentContextRecovery } from "../../src/agent/orchestration/recovery/agent-context-recovery.js";
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

test("AgentOrchestrator creates configured unlimited Artifact sources, but restoring does not register them again", async (t) => {
  const stage = new AuthorizationStage();
  let orchestrator: AgentOrchestrator | undefined;
  t.after(() => { orchestrator?.stop(); return stage.stop(); });
  const scope = await installTestRunScope(t, { runId: "agent-default-artifact-source" });
  orchestrator = new AgentOrchestrator([{ agentId: "producer", readers: [{ agentId: "consumer", phases: ["validate"] }] }]);
  await stage.start();
  await orchestrator.create();
  const [source] = scope.authorization.sources(agentPermissionRequestSourceType);
  assert.ok(source);
  assert.equal(source.sourceKey, "scout-artifact://workflow-001/producer/");
  assert.equal(source.maxApprovals, null);
  assert.deepEqual(source.origin, { kind: "workflow", runId: scope.runId, agentId: "producer" });
  assert.deepEqual(source.allowedGrants, [{
    scope: { workflowId: "workflow-001", agentId: "consumer", phases: ["validate"], access: "read" },
    target: { workflowId: "workflow-001", agentId: "producer", internalSymbols: [] },
  }]);
  const path = authorizationJournalPaths(scope.workflow.journalRoot).path;
  const facts = readJournalEvents(path);
  await stage.stop(); await stage.start();
  scope.authorization.restore(scope.workflow.snapshot()!);
  assert.deepEqual(scope.authorization.sources(agentPermissionRequestSourceType), [source]);
  // Native entity/task recovery is separate from the default-source creation policy.
  t.mock.method(AgentEntityRecovery.prototype, "restore", async () => undefined);
  t.mock.method(AgentTaskRecovery.prototype, "restore", async () => undefined);
  t.mock.method(AgentContextRecovery.prototype, "restore", async () => undefined);
  await orchestrator.restore(scope.workflow.snapshot()!);
  assert.deepEqual(scope.authorization.sources(agentPermissionRequestSourceType), [source]);
  assert.deepEqual(readJournalEvents(path), facts);
});
