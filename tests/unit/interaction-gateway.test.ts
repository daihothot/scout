import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryEventBus,
  type ScoutEvent,
} from "../../src/core/events/index.js";
import { InteractionGateway } from "../../src/interaction/index.js";
import type {
  AgentMessageReply,
  AgentMessageSend,
  RuntimeDisclosureEvent,
  RuntimeInteractionPort,
  RuntimeInteractionUnsubscribe,
  SubprocessProgressSnapshot,
} from "../../src/interaction/protocol/port.js";
import type {
  AgentActivity,
  AgentTurnActivity,
} from "../../src/agent/activity/activity-event.js";
import type { AgentTaskState } from "../../src/agent/task/types.js";
import type { AgentStepState } from "../../src/agent/step/types.js";
import { SystemEvents } from "../../src/system/events/index.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import type {
  InteractionExitRequestedPayload,
  UserMessageSubmittedPayload,
} from "../../src/interaction/gateway/interaction-events.js";
import { AgentTaskStatuses } from "../../src/agent/task/types.js";
import { TuiInteractionAdapter } from "../../src/interaction/tui/tui-interaction-adapter.js";
import { TuiStore } from "../../src/interaction/tui/tui-store.js";
import type { RunLifecycleSnapshot } from "../../src/run/lifecycle/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("interaction gateway publishes exit request from interaction port", async (t) => {
  const bus = new InMemoryEventBus();
  const port = new TestInteractionPort();
  installTestRunScope(t, {
    runId: "interaction-exit",
    eventBus: bus,
    interactionPort: port,
  });
  const gateway = new InteractionGateway();
  const observed: ScoutEvent<InteractionExitRequestedPayload>[] = [];
  bus.subscribe<InteractionExitRequestedPayload>(
    SystemEvents.interaction.exitRequested,
    (event) => {
      observed.push(event);
    },
  );

  gateway.start();
  await port.requestExit();
  gateway.stop();

  assert.equal(observed.length, 1);
  assert.equal(typeof observed[0]?.payload.requestedAt, "string");
});

test("interaction gateway waits for exit subscribers to finish", async (t) => {
  const bus = new InMemoryEventBus();
  const port = new TestInteractionPort();
  installTestRunScope(t, {
    runId: "interaction-exit-wait",
    eventBus: bus,
    interactionPort: port,
  });
  const gateway = new InteractionGateway();
  let terminated = false;
  bus.subscribe(SystemEvents.interaction.exitRequested, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    terminated = true;
  });

  gateway.start();
  await port.requestExit();
  gateway.stop();

  assert.equal(terminated, true);
});

test("interaction gateway separates Coordinator output from user input", async (t) => {
  const bus = new InMemoryEventBus();
  const port = new TestInteractionPort();
  installTestRunScope(t, {
    runId: "interaction-message-direction",
    eventBus: bus,
    interactionPort: port,
  });
  const gateway = new InteractionGateway();
  const observed: UserMessageSubmittedPayload[] = [];
  bus.subscribe<UserMessageSubmittedPayload>(
    SystemEvents.interaction.userMessageSubmitted,
    (event) => {
      observed.push(event.payload);
    },
  );

  gateway.start();
  bus.publish(AgentEvents.coordinator.messageProduced, {
    messageId: "coordinator-message-1",
    agentId: "coordinator",
    threadId: "thread-coordinator",
    turnId: "turn-coordinator-1",
    text: "Need input?",
    createdAt: "2026-07-04T00:00:00.000Z",
  });
  await flushMicrotasks();

  assert.deepEqual(port.receivedMessages, [{
    id: "coordinator-message-1",
    text: "Need input?",
    data: undefined,
  }]);
  assert.equal(port.taskEvents.length, 0);
  assert.equal(observed.length, 0);

  await port.sendMessage({
    id: "request-1",
    text: "answer",
  });

  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.messageId, "request-1");
  assert.equal(observed[0]?.text, "answer");
  assert.match(observed[0]?.attachment ?? "", /<coordinator-user>/);
  gateway.stop();
});

test("interaction gateway publishes every task event once", async (t) => {
  const bus = new InMemoryEventBus();
  const port = new TestInteractionPort();
  installTestRunScope(t, {
    runId: "interaction-task-events",
    eventBus: bus,
    interactionPort: port,
  });
  const gateway = new InteractionGateway();

  gateway.start();
  await bus.publishAndWait(
    AgentEvents.task.assigned,
    taskState({ status: AgentTaskStatuses.Queued }),
  );
  const disposed = taskState({
    stepIds: ["researcher-task-0001-step-0001"],
    dispositions: [{
      kind: "protocol_violation",
      stepId: "researcher-task-0001-step-0001",
      turnId: "turn-1",
      callId: null,
      timestamp: "2026-07-10T00:00:02.000Z",
      reason: "missing disposition",
    }],
  });
  await bus.publishAndWait(AgentEvents.task.dispositionRecorded, {
    task: disposed,
    disposition: disposed.dispositions[0]!,
  });
  await bus.publishAndWait(AgentEvents.task.done, taskState({
    status: AgentTaskStatuses.Done,
    updatedAt: "2026-07-10T00:00:03.000Z",
    stepIds: ["researcher-task-0001-step-0001"],
  }));
  await bus.publishAndWait(AgentEvents.task.archived, taskState({
    status: AgentTaskStatuses.Done,
    updatedAt: "2026-07-10T00:00:04.000Z",
    stepIds: ["researcher-task-0001-step-0001"],
  }));
  gateway.stop();

  assert.deepEqual(
    port.taskEvents.map((event) => event.key.routeKey),
    [
      AgentEvents.task.assigned.routeKey,
      AgentEvents.task.dispositionRecorded.routeKey,
      AgentEvents.task.done.routeKey,
      AgentEvents.task.archived.routeKey,
    ],
  );
});

test("interaction gateway projects assigned task plan and Worker activity into TuiStore", async (t) => {
  const bus = new InMemoryEventBus();
  const store = new TuiStore({
    cwd: "/repo/scout",
    version: "0.1.0",
    model: "gpt-5.5",
    reasoningEffort: "high",
  });
  installTestRunScope(t, {
    runId: "interaction-tui-projection",
    eventBus: bus,
    interactionPort: new TuiInteractionAdapter(store),
  });
  const gateway = new InteractionGateway();

  gateway.start();
  await bus.publishAndWait(
    AgentEvents.task.assigned,
    taskState({
      status: AgentTaskStatuses.Queued,
      stepIds: ["researcher-task-0001-step-0001"],
    }),
  );
  await bus.publishAndWait(
    AgentEvents.step.started,
    stepState({ plan: taskPlan("inProgress") }),
  );
  await bus.publishAndWait(
    AgentEvents.step.planUpdated,
    {
      stepId: "researcher-task-0001-step-0001",
      agentId: "researcher",
      taskId: "researcher-task-0001",
      turnId: "turn-1",
      plan: taskPlan("inProgress"),
      updatedAt: "2026-07-10T00:00:02.000Z",
    },
  );
  await bus.publishAndWait(AgentEvents.activity.observed, {
    seq: 1,
    agentId: "researcher",
    role: "researcher",
    taskId: "researcher-task-0001",
    threadId: "thread-researcher",
    itemId: "worker-item-1",
    type: "reasoning",
    status: "completed",
    label: "Reasoning",
    detail: "Locate the current Behavior source.",
    updatedAt: "2026-07-10T00:00:02.000Z",
  } satisfies AgentActivity);
  await bus.publishAndWait(AgentEvents.activity.turnObserved, {
    seq: 2,
    agentId: "researcher",
    role: "researcher",
    taskId: "researcher-task-0001",
    threadId: "thread-researcher",
    turnId: "turn-1",
    status: "inProgress",
    updatedAt: "2026-07-10T00:00:03.000Z",
  } satisfies AgentTurnActivity);

  assert.deepEqual(store.snapshot().tasks[0]?.turns, [{
    stepId: "researcher-task-0001-step-0001",
    turnId: "turn-1",
    status: "running",
    planSteps: [{
      step: "Locate BDD and Behavior source",
      status: "inProgress",
    }],
  }]);
  assert.equal(store.snapshot().activities[0]?.taskId, "researcher-task-0001");
  assert.equal(store.snapshot().turnActivities[0]?.status, "inProgress");

  await bus.publishAndWait(AgentEvents.task.done, taskState({
    status: AgentTaskStatuses.Done,
    updatedAt: "2026-07-10T00:00:03.000Z",
    stepIds: ["researcher-task-0001-step-0001"],
  }));
  await bus.publishAndWait(AgentEvents.step.completed, stepState({
    status: "completed",
    plan: taskPlan("completed"),
    finishedAt: "2026-07-10T00:00:03.000Z",
    updatedAt: "2026-07-10T00:00:03.000Z",
  }));

  assert.equal(store.snapshot().tasks.length, 1);
  assert.equal(store.snapshot().tasks[0]?.status, AgentTaskStatuses.Done);
  assert.equal(store.snapshot().tasks[0]?.turns[0]?.planSteps[0]?.status, "completed");

  await bus.publishAndWait(AgentEvents.task.archived, taskState({
    status: AgentTaskStatuses.Done,
    updatedAt: "2026-07-10T00:00:04.000Z",
    stepIds: ["researcher-task-0001-step-0001"],
  }));
  gateway.stop();

  assert.equal(store.snapshot().tasks.length, 1);
  assert.equal(store.snapshot().tasks[0]?.status, "archived");
  assert.equal(store.snapshot().tasks[0]?.turns[0]?.planSteps[0]?.status, "completed");
});

class TestInteractionPort implements RuntimeInteractionPort {
  private exitHandler?: () => void | Promise<void>;
  private sendHandler?: (message: AgentMessageSend) => void | Promise<void>;
  readonly receivedMessages: AgentMessageReply[] = [];
  readonly taskEvents: ScoutEvent[] = [];
  readonly stepEvents: ScoutEvent[] = [];

  async publishRunLifecycleSnapshot(_snapshot: RunLifecycleSnapshot): Promise<void> {
    return undefined;
  }

  async publishSubprocessProgress(_progress: SubprocessProgressSnapshot): Promise<void> {
    return undefined;
  }

  async disclose(_event: RuntimeDisclosureEvent): Promise<void> {
    return undefined;
  }

  async publishAgentActivity(_activity: AgentActivity): Promise<void> {
    return undefined;
  }

  async publishAgentTurnActivity(_activity: AgentTurnActivity): Promise<void> {
    return undefined;
  }

  async publishTaskEvent(event: ScoutEvent): Promise<void> {
    this.taskEvents.push(event);
  }

  async publishStepEvent(event: ScoutEvent): Promise<void> {
    this.stepEvents.push(event);
  }

  async restoreTaskSnapshot(_task: AgentTaskState): Promise<void> {
    return undefined;
  }

  async receiveAgentMessage(_message: AgentMessageReply): Promise<void> {
    this.receivedMessages.push(_message);
    return undefined;
  }

  async restoreUserMessage(): Promise<void> {
    return undefined;
  }

  sendAgentMessage(handler: (message: AgentMessageSend) => void | Promise<void>): RuntimeInteractionUnsubscribe {
    this.sendHandler = handler;
    return () => {
      this.sendHandler = undefined;
    };
  }

  onExitRequested(handler: () => void | Promise<void>): RuntimeInteractionUnsubscribe {
    this.exitHandler = handler;
    return () => {
      this.exitHandler = undefined;
    };
  }

  async requestExit(): Promise<void> {
    await this.exitHandler?.();
  }

  async sendMessage(message: AgentMessageSend): Promise<void> {
    await this.sendHandler?.(message);
  }
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function taskState(input: Partial<AgentTaskState> = {}): AgentTaskState {
  return {
    type: "local_agent",
    taskId: "researcher-task-0001",
    taskSequence: 1,
    agentId: "researcher",
    role: "researcher",
    phase: "research",
    description: "Research current BDD evidence",
    initialPrompt: "Research current BDD evidence",
    status: AgentTaskStatuses.Running,
    isBackgrounded: true,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:01.000Z",
    ...input,
    stepIds: input.stepIds ?? [],
    dispositions: input.dispositions ?? [],
  };
}

function stepState(input: Partial<AgentStepState> = {}): AgentStepState {
  return {
    stepId: "researcher-task-0001-step-0001",
    agentId: "researcher",
    taskId: "researcher-task-0001",
    turnId: "turn-1",
    status: "running",
    prompt: "Research current BDD evidence",
    toolCallIds: [],
    humanInputReferences: [],
    startedAt: "2026-07-10T00:00:01.000Z",
    updatedAt: "2026-07-10T00:00:01.000Z",
    ...input,
  };
}

function taskPlan(status: "inProgress" | "completed") {
  return {
    turnId: "turn-1",
    explanation: "Research current-version evidence.",
    steps: [{
      step: "Locate BDD and Behavior source",
      status,
      raw: {},
    }],
  };
}
