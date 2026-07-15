import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentMessageSend,
} from "../../src/interaction/protocol/port.js";
import type { AgentActivity } from "../../src/agent/activity/activity-event.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import type { AgentTaskState } from "../../src/agent/task/types.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { TuiStore } from "../../src/interaction/tui/tui-store.js";
import type { BootSnapshot } from "../../src/run/boot/boot-stage.js";

test("TuiStore emits user-message ids for user input", () => {
  const store = createStore();
  const sent: AgentMessageSend[] = [];
  store.sendAgentMessage((message) => {
    sent.push(message);
  });

  store.receiveAgentMessage({
    id: "coordinator-message-1",
    text: "Coordinator reply",
  });
  store.setRun({ status: "ready" });
  store.submitInput("  继续  ");

  assert.equal(sent.length, 1);
  assert.match(sent[0]?.id ?? "", /^user-message-\d+$/);
  assert.notEqual(sent[0]?.id, "coordinator-message-1");
  assert.equal(sent[0]?.text, "继续");
});

test("TuiStore does not deliver ordinary input before the run is ready", () => {
  const store = createStore();
  const sent: AgentMessageSend[] = [];
  store.sendAgentMessage((message) => {
    sent.push(message);
  });

  store.submitInput("too early");

  assert.deepEqual(sent, []);
  assert.deepEqual(store.snapshot().logs, []);
});

test("TuiStore projects Boot snapshots into runtime state", () => {
  const store = createStore();
  const snapshot = bootSnapshot({
    status: "starting",
    completedStages: 1,
    stages: [
      { id: "interaction", status: "completed" },
      { id: "clients", status: "running" },
    ],
  });

  store.setBootSnapshot(snapshot);
  snapshot.stages[0]!.status = "failed";

  assert.equal(store.snapshot().runtime.runId, "run-boot-test");
  assert.equal(store.snapshot().runtime.status, "preparing");
  assert.equal(store.snapshot().boot?.stages[0]?.status, "completed");

  store.setBootSnapshot(bootSnapshot({ status: "ready", completedStages: 2 }));
  assert.equal(store.snapshot().runtime.status, "ready");

  store.setBootSnapshot(bootSnapshot({ status: "failed", completedStages: 1 }));
  assert.equal(store.snapshot().runtime.status, "failed");
});

test("TuiStore tracks runtime metadata", () => {
  const store = createStore();

  assert.deepEqual(store.snapshot().runtime, {
    cwd: "/repo/scout",
    version: "0.1.0",
    model: "gpt-5.5",
    reasoningEffort: "high",
    status: "preparing",
  });

  store.setRun({
    runId: "run-1",
    status: "ready",
  });

  assert.deepEqual(store.snapshot().runtime, {
    cwd: "/repo/scout",
    version: "0.1.0",
    model: "gpt-5.5",
    reasoningEffort: "high",
    runId: "run-1",
    status: "ready",
  });
});

test("TuiStore preserves same activity item id for Coordinator and Worker", () => {
  const store = createStore();
  store.addAgentActivity(activity({
    agentId: "coordinator",
    label: "Coordinator thinking",
  }));
  store.addAgentActivity(activity({
    agentId: "researcher",
    label: "Researcher searching",
  }));

  const activities = store.snapshot().activities;
  assert.equal(activities.length, 2);
  assert.equal(store.snapshot().logs.length, 0);
  assert.deepEqual(
    activities.map((item) => [item.agentId, item.label]),
    [
      ["coordinator", "Coordinator thinking"],
      ["researcher", "Researcher searching"],
    ],
  );
});

test("TuiStore hides dynamic tool calls and retains Worker activity", () => {
  const store = createStore();
  store.addAgentActivity(activity({
    agentId: "researcher",
    taskId: "researcher-task-0001",
    type: "dynamicToolCall",
    label: "update_plan",
  }));
  store.addAgentActivity(activity({
    agentId: "researcher",
    taskId: "researcher-task-0001",
    type: "commandExecution",
    label: "rg BDD-001",
  }));

  assert.deepEqual(
    store.snapshot().activities.map((event) => [event.type, event.label]),
    [["commandExecution", "rg BDD-001"]],
  );
});

test("TuiStore ignores task updates until assignment is confirmed", () => {
  const store = createStore();
  const bus = new InMemoryEventBus();
  const unassigned = taskState({
    plan: {
      turnId: "turn-1",
      explanation: "Research the selected BDD.",
      steps: [{ step: "Locate BDD", status: "inProgress", raw: {} }],
    },
  });

  store.addTaskEvent(bus.publish(AgentEvents.task.planUpdated, unassigned));

  assert.deepEqual(store.snapshot().tasks, []);
  assert.deepEqual(store.snapshot().logs, []);
});

test("TuiStore keeps a done task visible until archive removes it", () => {
  const store = createStore();
  const bus = new InMemoryEventBus();
  const assigned = taskState();
  const plan = {
    turnId: "turn-1",
    explanation: "Research the selected BDD.",
    steps: [
      { step: "Read role and skills", status: "completed" as const, raw: {} },
      { step: "Locate BDD", status: "inProgress" as const, raw: {} },
      { step: "Write research artifact", status: "pending" as const, raw: {} },
    ],
  };

  store.addTaskEvent(bus.publish(AgentEvents.task.assigned, assigned));
  store.addTaskEvent(bus.publish(AgentEvents.task.planUpdated, taskState({ plan })));
  store.addTaskEvent(bus.publish(AgentEvents.task.done, taskState({
    status: "done",
    updatedAt: "2026-07-10T00:00:03.000Z",
    plan: {
      ...plan,
      steps: plan.steps.map((step) => ({ ...step, status: "completed" as const })),
    },
  })));

  assert.deepEqual(store.snapshot().tasks, [{
    taskId: "researcher-task-0001",
    taskSequence: 1,
    agentId: "researcher",
    role: "researcher",
    status: "done",
    description: "Research BDD evidence",
    updatedAt: "2026-07-10T00:00:03.000Z",
    planSteps: [
      { step: "Read role and skills", status: "completed" },
      { step: "Locate BDD", status: "completed" },
      { step: "Write research artifact", status: "completed" },
    ],
  }]);
  assert.deepEqual(store.snapshot().logs, []);

  store.addTaskEvent(bus.publish(AgentEvents.task.archived, taskState({
    status: "done",
    updatedAt: "2026-07-10T00:00:04.000Z",
  })));

  assert.deepEqual(store.snapshot().tasks, []);
});

function createStore(): TuiStore {
  return new TuiStore({
    cwd: "/repo/scout",
    version: "0.1.0",
    model: "gpt-5.5",
    reasoningEffort: "high",
  });
}

function activity(input: {
  agentId: typeof ScoutAgentRoles.Coordinator | typeof ScoutAgentRoles.Researcher;
  label: string;
  taskId?: string;
  type?: string;
}): AgentActivity {
  return {
    seq: 1,
    agentId: input.agentId,
    role: input.agentId,
    taskId: input.taskId,
    threadId: `thread-${input.agentId}`,
    itemId: "item-1",
    type: input.type ?? "agentMessage",
    status: "inProgress",
    label: input.label,
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

function taskState(input: Partial<AgentTaskState> = {}): AgentTaskState {
  return {
    type: "local_agent",
    taskId: "researcher-task-0001",
    taskSequence: 1,
    agentId: "researcher",
    role: ScoutAgentRoles.Researcher,
    description: "Research BDD evidence",
    initialPrompt: "Research BDD evidence",
    status: "running",
    isBackgrounded: true,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...input,
  };
}

function bootSnapshot(input: Partial<BootSnapshot> = {}): BootSnapshot {
  return {
    runId: "run-boot-test",
    status: "starting",
    completedStages: 0,
    totalStages: 2,
    stages: [
      { id: "interaction", status: "pending" },
      { id: "clients", status: "pending" },
    ],
    ...input,
  };
}
