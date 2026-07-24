import assert from "node:assert/strict";
import test from "node:test";
import { AgentEvents } from "../../src/agent/events/index.js";
import { AgentOrchestrator } from "../../src/agent/orchestration/agent-orchestrator.js";
import { AgentTaskStatuses } from "../../src/agent/task/types.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("AgentOrchestrator owns its lifecycle and consumes task events", async (t) => {
  const eventBus = new InMemoryEventBus();
  installTestRunScope(t, { runId: "agent-orchestrator", eventBus });
  const orchestrator = new AgentOrchestrator();

  assert.deepEqual(orchestrator.snapshot(), {
    started: false,
    stopped: false,
    pendingEventCount: 0,
  });

  orchestrator.start();
  await eventBus.publishAndWait(AgentEvents.task.assigned, {
    type: "local_agent",
    taskId: "researcher-task-0001",
    taskSequence: 1,
    agentId: ScoutAgentRoles.Researcher,
    role: ScoutAgentRoles.Researcher,
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
});
