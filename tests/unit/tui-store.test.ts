import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentMessageSend,
  MountRestoreProgress,
} from "../../src/interaction/protocol/port.js";
import type {
  AgentActivity,
  AgentTurnActivity,
} from "../../src/agent/activity/activity-event.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import type { AgentTaskState } from "../../src/agent/task/types.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { TuiStore } from "../../src/interaction/tui/tui-store.js";
import type { RunLifecycleSnapshot } from "../../src/run/lifecycle/index.js";

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

test("TuiStore projects Run lifecycle snapshots into runtime state", () => {
  const store = createStore();
  const snapshot = lifecycleSnapshot({
    status: "starting",
    completedStages: 1,
    stages: [
      { id: "interaction", status: "completed" },
      { id: "clients", status: "running" },
    ],
  });

  store.setRunLifecycleSnapshot(snapshot);
  snapshot.stages[0]!.status = "failed";

  assert.equal(store.snapshot().runtime.runId, "run-boot-test");
  assert.equal(store.snapshot().runtime.status, "preparing");
  assert.equal(store.snapshot().lifecycle?.stages[0]?.status, "completed");

  store.setRunLifecycleSnapshot(lifecycleSnapshot({ status: "ready", completedStages: 2 }));
  assert.equal(store.snapshot().runtime.status, "ready");

  store.setRunLifecycleSnapshot(lifecycleSnapshot({ status: "failed", completedStages: 1 }));
  assert.equal(store.snapshot().runtime.status, "failed");
});

test("TuiStore projects and clones mount restore progress", () => {
  const store = createStore();
  const progress: MountRestoreProgress = {
    phase: "rebuild",
    activeRole: ScoutAgentRoles.Validator,
    activeStep: "config",
    roles: [
      { role: ScoutAgentRoles.Coordinator, decision: "reused" },
      { role: ScoutAgentRoles.Validator, decision: "rebuild", step: "config" },
    ],
    completedUnits: 7,
    totalUnits: 8,
  };

  store.setMountRestoreProgress(progress);
  progress.roles[0]!.decision = "failed";
  const snapshot = store.snapshot();

  assert.equal(snapshot.mountRestore?.phase, "rebuild");
  assert.equal(snapshot.mountRestore?.roles[0]?.decision, "reused");
  assert.equal(snapshot.mountRestore?.completedUnits, 7);
});

test("TuiStore clears completed mount progress when the mount stage advances", () => {
  const store = createStore();
  store.setMountRestoreProgress({
    phase: "done",
    roles: [{ role: ScoutAgentRoles.Coordinator, decision: "reused" }],
    completedUnits: 1,
    totalUnits: 1,
  });

  store.setRunLifecycleSnapshot(lifecycleSnapshot({
    stages: [{ id: "environment", status: "completed" }],
  }));

  assert.equal(store.snapshot().mountRestore, undefined);
});

test("TuiStore keeps a mount failure visible through stopped lifecycle snapshots", () => {
  const store = createStore();
  store.setMountRestoreProgress({
    phase: "failed",
    activeRole: ScoutAgentRoles.Validator,
    activeStep: "preflight",
    roles: [{
      role: ScoutAgentRoles.Validator,
      decision: "failed",
      step: "preflight",
      reason: "app-server unavailable",
    }],
    completedUnits: 5,
    totalUnits: 6,
  });

  store.setRunLifecycleSnapshot(lifecycleSnapshot({
    status: "failed",
    stages: [{ id: "restore_environment", status: "stopped" }],
  }));

  assert.equal(store.snapshot().mountRestore?.phase, "failed");
  store.setRun({ status: "stopping" });
  assert.equal(store.snapshot().mountRestore, undefined);
});

test("TuiStore clears mount state immediately when switching runs", () => {
  const store = createStore();
  store.setRun({ runId: "run-old", status: "preparing" });
  store.setMountRestoreProgress({
    phase: "failed",
    activeRole: ScoutAgentRoles.Validator,
    activeStep: "preflight",
    roles: [{
      role: ScoutAgentRoles.Validator,
      decision: "failed",
      step: "preflight",
    }],
    completedUnits: 5,
    totalUnits: 6,
  });

  store.setRun({ runId: "run-new", status: "preparing" });

  assert.equal(store.snapshot().runtime.runId, "run-new");
  assert.equal(store.snapshot().mountRestore, undefined);
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

test("TuiStore retains the latest lifecycle state for each Agent turn", () => {
  const store = createStore();
  const started = turnActivity({ status: "inProgress", seq: 1 });
  store.addAgentTurnActivity(started);
  store.addAgentTurnActivity(turnActivity({
    status: "completed",
    seq: 4,
    updatedAt: "2026-07-10T00:00:04.000Z",
  }));

  assert.deepEqual(store.snapshot().turnActivities, [{
    ...started,
    seq: 4,
    status: "completed",
    updatedAt: "2026-07-10T00:00:04.000Z",
  }]);
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

test("TuiStore appends plans across turns and keeps them after archive", () => {
  const store = createStore();
  const bus = new InMemoryEventBus();
  const assigned = taskState();
  const firstPlan = {
    turnId: "turn-1",
    explanation: "Research the selected BDD.",
    steps: [
      { step: "Read role and skills", status: "completed" as const, raw: {} },
      { step: "Locate BDD", status: "inProgress" as const, raw: {} },
    ],
  };
  const completedFirstPlan = {
    ...firstPlan,
    steps: firstPlan.steps.map((step) => ({ ...step, status: "completed" as const })),
  };
  const secondPlan = {
    turnId: "turn-2",
    explanation: "Write the Research pack.",
    steps: [
      { step: "Write research artifact", status: "completed" as const, raw: {} },
      { step: "Submit research handoff", status: "completed" as const, raw: {} },
    ],
  };

  store.addTaskEvent(bus.publish(AgentEvents.task.assigned, assigned));
  store.addTaskEvent(bus.publish(AgentEvents.task.planUpdated, taskState({
    plan: firstPlan,
    planRecords: [firstPlan],
  })));
  store.addTaskEvent(bus.publish(AgentEvents.task.done, taskState({
    status: "done",
    updatedAt: "2026-07-10T00:00:03.000Z",
    plan: secondPlan,
    planRecords: [completedFirstPlan, secondPlan],
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
      { step: "Submit research handoff", status: "completed" },
    ],
  }]);
  assert.deepEqual(
    store.snapshot().logs.map((log) => [log.kind, log.text]),
    [
      ["system", "任务 researcher-task-0001 已指派给 researcher。"],
      ["system", "任务 researcher-task-0001 已交回本轮结果，等待 Coordinator 后续处理。"],
    ],
  );

  const archivedEvent = bus.publish(AgentEvents.task.archived, taskState({
    status: "done",
    updatedAt: "2026-07-10T00:00:04.000Z",
  }));
  store.addTaskEvent(archivedEvent);

  assert.deepEqual(store.snapshot().tasks, [{
    taskId: "researcher-task-0001",
    taskSequence: 1,
    agentId: "researcher",
    role: "researcher",
    status: "archived",
    description: "Research BDD evidence",
    updatedAt: archivedEvent.occurredAt,
    planSteps: [
      { step: "Read role and skills", status: "completed" },
      { step: "Locate BDD", status: "completed" },
      { step: "Write research artifact", status: "completed" },
      { step: "Submit research handoff", status: "completed" },
    ],
  }]);
  assert.equal(store.snapshot().logs.at(-1)?.text, "任务 researcher-task-0001 已归档。");
});

test("TuiStore reports human confirmation without projecting a waiting task status", () => {
  const store = createStore();
  const bus = new InMemoryEventBus();
  store.addTaskEvent(bus.publish(AgentEvents.task.assigned, taskState()));
  store.addTaskEvent(bus.publish(AgentEvents.task.stepCompleted, taskState({
    status: "running",
    steps: [{
      stepId: "researcher-task-0001-step-0001",
      taskId: "researcher-task-0001",
      status: "completed",
      prompt: "查证当前版本。",
      toolCalls: [],
      startedAt: "2026-07-10T00:00:00.000Z",
      finishedAt: "2026-07-10T00:00:01.000Z",
      humanInputRequest: { body: "请确认目标版本。" },
    }],
  })));

  assert.equal(store.snapshot().tasks[0]?.status, "running");
  assert.equal(
    store.snapshot().logs.at(-1)?.text,
    "任务 researcher-task-0001 已请求人工确认。",
  );
});

function createStore(): TuiStore {
  return new TuiStore({
    cwd: "/repo/scout",
    version: "0.1.0",
    model: "gpt-5.5",
    reasoningEffort: "high",
  });
}

function turnActivity(input: Partial<AgentTurnActivity> = {}): AgentTurnActivity {
  return {
    seq: 1,
    agentId: "researcher",
    role: "researcher",
    taskId: "researcher-task-0001",
    threadId: "thread-researcher",
    turnId: "turn-1",
    status: "inProgress",
    updatedAt: "2026-07-10T00:00:01.000Z",
    ...input,
  };
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

function lifecycleSnapshot(
  input: Partial<RunLifecycleSnapshot> = {},
): RunLifecycleSnapshot {
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
