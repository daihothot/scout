import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentMessageSend,
  RuntimeProgressEvent,
} from "../../src/interaction/port.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import type { AgentTaskEventPayload } from "../../src/agent/task/task-events.js";
import type { AgentTaskState } from "../../src/agent/task/types.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { TuiStore } from "../../src/interaction/tui/tui-store.js";

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
  store.submitInput("  继续  ");

  assert.equal(sent.length, 1);
  assert.match(sent[0]?.id ?? "", /^user-message-\d+$/);
  assert.notEqual(sent[0]?.id, "coordinator-message-1");
  assert.equal(sent[0]?.text, "继续");
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

test("TuiStore preserves same item id for Coordinator and Worker", () => {
  const store = createStore();
  store.addProgress(progressEvent({
    agentId: "coordinator",
    label: "Coordinator thinking",
  }));
  store.addProgress(progressEvent({
    agentId: "researcher",
    label: "Researcher searching",
  }));

  const progress = store.snapshot().progress;
  assert.equal(progress.length, 2);
  assert.equal(store.snapshot().logs.length, 0);
  assert.deepEqual(
    progress.map((item) => [item.agentId, item.label]),
    [
      ["coordinator", "Coordinator thinking"],
      ["researcher", "Researcher searching"],
    ],
  );
});

test("TuiStore hides dynamic tool calls and retains Worker progress", () => {
  const store = createStore();
  store.addProgress(progressEvent({
    agentId: "researcher",
    taskId: "researcher-task-0001",
    type: "dynamicToolCall",
    label: "update_plan",
  }));
  store.addProgress(progressEvent({
    agentId: "researcher",
    taskId: "researcher-task-0001",
    type: "commandExecution",
    label: "rg BDD-001",
  }));

  assert.deepEqual(
    store.snapshot().progress.map((event) => [event.type, event.label]),
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

  store.addTaskEvent(bus.publish(AgentEvents.task.planUpdated, {
    task: unassigned,
  } satisfies AgentTaskEventPayload));

  assert.deepEqual(store.snapshot().tasks, []);
  assert.deepEqual(store.snapshot().logs, []);
});

test("TuiStore tracks assigned task plan through terminal without raw task logs", () => {
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

  store.addTaskEvent(bus.publish(AgentEvents.task.assigned, {
    task: assigned,
  } satisfies AgentTaskEventPayload));
  store.addTaskEvent(bus.publish(AgentEvents.task.planUpdated, {
    task: taskState({ plan }),
  } satisfies AgentTaskEventPayload));
  store.addTaskEvent(bus.publish(AgentEvents.task.terminal, {
    task: taskState({
      status: "complete",
      updatedAt: "2026-07-10T00:00:03.000Z",
      plan: {
        ...plan,
        steps: plan.steps.map((step) => ({ ...step, status: "completed" as const })),
      },
    }),
  } satisfies AgentTaskEventPayload));

  assert.deepEqual(store.snapshot().tasks, [{
    taskId: "researcher-task-0001",
    taskSequence: 1,
    agentId: "researcher",
    role: "researcher",
    status: "complete",
    description: "Research BDD evidence",
    updatedAt: "2026-07-10T00:00:03.000Z",
    planSteps: [
      { step: "Read role and skills", status: "completed" },
      { step: "Locate BDD", status: "completed" },
      { step: "Write research artifact", status: "completed" },
    ],
  }]);
  assert.deepEqual(store.snapshot().logs, []);
});

function createStore(): TuiStore {
  return new TuiStore({
    cwd: "/repo/scout",
    version: "0.1.0",
    model: "gpt-5.5",
    reasoningEffort: "high",
  });
}

function progressEvent(input: {
  agentId: string;
  label: string;
  taskId?: string;
  type?: string;
}): RuntimeProgressEvent {
  return {
    source: "agent.app_server.item",
    agentId: input.agentId,
    taskId: input.taskId,
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
