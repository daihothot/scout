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
  RuntimeProgressEvent,
} from "../../src/interaction/port.js";
import type {
  AgentTaskEvent,
  AgentTaskEventPayload,
} from "../../src/agent/task/task-events.js";
import type { AgentTaskState } from "../../src/agent/task/types.js";
import { SystemEvents } from "../../src/system/events/index.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import type {
  InteractionExitRequestedPayload,
  UserMessageSubmittedPayload,
} from "../../src/interaction/gateway/interaction-events.js";
import { AgentTaskStatuses } from "../../src/agent/task/types.js";
import { TuiInteractionAdapter } from "../../src/interaction/tui/tui-interaction-adapter.js";
import { TuiStore } from "../../src/interaction/tui/tui-store.js";

test("interaction gateway publishes exit request from interaction port", async () => {
  const bus = new InMemoryEventBus();
  const port = new TestInteractionPort();
  const gateway = new InteractionGateway({
    eventBus: bus,
    interactionPort: port,
  });
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

test("interaction gateway separates receiving agent message from sending human message", async () => {
  const bus = new InMemoryEventBus();
  const port = new TestInteractionPort();
  const gateway = new InteractionGateway({
    eventBus: bus,
    interactionPort: port,
  });
  const observed: UserMessageSubmittedPayload[] = [];
  bus.subscribe<UserMessageSubmittedPayload>(
    SystemEvents.interaction.userMessageSubmitted,
    (event) => {
      observed.push(event.payload);
    },
  );

  gateway.start();
  bus.publish(AgentEvents.task.humanInputRequested, {
    task: {
      type: "local_agent",
      taskId: "task-1",
      taskSequence: 1,
      agentId: "researcher",
      role: "researcher",
      description: "need input",
      initialPrompt: "initial",
      status: AgentTaskStatuses.WaitingForHumanInput,
      isBackgrounded: false,
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z",
    },
    request: {
      requestId: "request-1",
      agentId: "researcher",
      taskId: "task-1",
      kind: "prompt_required",
      question: "Need input?",
      createdAt: "2026-07-04T00:00:00.000Z",
      status: "pending",
    },
  });
  await flushMicrotasks();

  assert.equal(port.receivedMessages.length, 0);
  assert.equal(port.taskEvents.length, 1);
  assert.equal(port.notifications.length, 1);
  assert.equal(port.notifications[0]?.payload.task.taskId, "task-1");
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

test("interaction gateway projects every task event while limiting notifications", async () => {
  const bus = new InMemoryEventBus();
  const port = new TestInteractionPort();
  const gateway = new InteractionGateway({
    eventBus: bus,
    interactionPort: port,
  });

  gateway.start();
  await bus.publishAndWait(AgentEvents.task.assigned, {
    task: taskState({ status: AgentTaskStatuses.Queued }),
  } satisfies AgentTaskEventPayload);
  await bus.publishAndWait(AgentEvents.task.planUpdated, {
    task: taskState({ plan: taskPlan("inProgress") }),
  } satisfies AgentTaskEventPayload);
  await bus.publishAndWait(AgentEvents.task.terminal, {
    task: taskState({
      status: AgentTaskStatuses.Complete,
      updatedAt: "2026-07-10T00:00:03.000Z",
      plan: taskPlan("completed"),
    }),
  } satisfies AgentTaskEventPayload);
  gateway.stop();

  assert.deepEqual(
    port.taskEvents.map((event) => event.key.routeKey),
    [
      AgentEvents.task.assigned.routeKey,
      AgentEvents.task.planUpdated.routeKey,
      AgentEvents.task.terminal.routeKey,
    ],
  );
  assert.deepEqual(
    port.notifications.map((event) => event.key.routeKey),
    [AgentEvents.task.terminal.routeKey],
  );
});

test("interaction gateway projects assigned task plan and Worker progress into TuiStore", async () => {
  const bus = new InMemoryEventBus();
  const store = new TuiStore({
    cwd: "/repo/scout",
    version: "0.1.0",
    model: "gpt-5.5",
    reasoningEffort: "high",
  });
  const gateway = new InteractionGateway({
    eventBus: bus,
    interactionPort: new TuiInteractionAdapter(store),
  });

  gateway.start();
  await bus.publishAndWait(AgentEvents.task.assigned, {
    task: taskState({ status: AgentTaskStatuses.Queued }),
  } satisfies AgentTaskEventPayload);
  await bus.publishAndWait(AgentEvents.task.planUpdated, {
    task: taskState({ plan: taskPlan("inProgress") }),
  } satisfies AgentTaskEventPayload);
  await bus.publishAndWait(SystemEvents.interaction.progressRequested, {
    source: "agent.app_server.item",
    agentId: "researcher",
    taskId: "researcher-task-0001",
    itemId: "worker-item-1",
    type: "reasoning",
    status: "completed",
    label: "Reasoning",
    detail: "Locate the current Behavior source.",
    updatedAt: "2026-07-10T00:00:02.000Z",
  } satisfies RuntimeProgressEvent);

  assert.deepEqual(store.snapshot().tasks[0]?.planSteps, [{
    step: "Locate BDD and Behavior source",
    status: "inProgress",
  }]);
  assert.equal(store.snapshot().progress[0]?.taskId, "researcher-task-0001");

  await bus.publishAndWait(AgentEvents.task.terminal, {
    task: taskState({
      status: AgentTaskStatuses.Complete,
      updatedAt: "2026-07-10T00:00:03.000Z",
      plan: taskPlan("completed"),
    }),
  } satisfies AgentTaskEventPayload);
  gateway.stop();

  assert.equal(store.snapshot().tasks.length, 1);
  assert.equal(store.snapshot().tasks[0]?.status, AgentTaskStatuses.Complete);
  assert.equal(store.snapshot().tasks[0]?.planSteps[0]?.status, "completed");
});

class TestInteractionPort implements RuntimeInteractionPort {
  private exitHandler?: () => void | Promise<void>;
  private sendHandler?: (message: AgentMessageSend) => void | Promise<void>;
  readonly receivedMessages: AgentMessageReply[] = [];
  readonly taskEvents: AgentTaskEvent[] = [];
  readonly notifications: AgentTaskEvent[] = [];

  async disclose(_event: RuntimeDisclosureEvent): Promise<void> {
    return undefined;
  }

  async publishProgress(_event: RuntimeProgressEvent): Promise<void> {
    return undefined;
  }

  async publishTaskEvent(event: AgentTaskEvent): Promise<void> {
    this.taskEvents.push(event);
  }

  async notify(_event: AgentTaskEvent): Promise<void> {
    this.notifications.push(_event);
    return undefined;
  }

  async receiveAgentMessage(_message: AgentMessageReply): Promise<void> {
    this.receivedMessages.push(_message);
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
    description: "Research current BDD evidence",
    initialPrompt: "Research current BDD evidence",
    status: AgentTaskStatuses.Running,
    isBackgrounded: true,
    createdAt: "2026-07-10T00:00:00.000Z",
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
