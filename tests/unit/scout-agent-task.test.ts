import test from "node:test";
import assert from "node:assert/strict";
import { AgentTaskBackend } from "../../src/agent/backend/agent-task-backend.js";
import { AgentRegistry } from "../../src/agent/core/agent-registry.js";
import { WorkerRunner } from "../../src/agent/runner/worker-runner.js";
import { AgentTaskStore } from "../../src/agent/task/agent-task-store.js";
import { ScoutAgentRoles, ScoutAgentPhases } from "../../src/agent/thread/types.js";
import type { Logger } from "../../src/core/logging/index.js";
import type {
  AgentTaskState,
} from "../../src/agent/task/types.js";
import {
  AgentTaskOutcomeStatuses,
  AgentTaskStatuses,
  AgentTaskStepStatuses,
} from "../../src/agent/task/types.js";
import type {
  AgentTaskEventPayload,
  AgentTaskSystemEvent,
} from "../../src/agent/task/task-events.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { SystemEvents } from "../../src/system/events/index.js";
import type {
  ScoutAgentTurnInput,
  ScoutAgentTurnOutcome,
  ScoutAgent,
} from "../../src/agent/core/scout-agent.js";
import type { AgentThreadSnapshot } from "../../src/agent/thread/types.js";
import type {
  AppServerPlanState,
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
} from "../../src/agent-server/codex/app-server-event-store.js";

test("WorkerRunner keeps task running and schedules a tick when a turn completes without TaskResult", async () => {
  const harness = createHarness({
    runTurn: async () => completedTurn("worker response without task result"),
  });

  harness.runtime.assignTask({
    taskId: "task-1",
    description: "Verify behavior",
    subagentType: ScoutAgentRoles.Verifier,
    prompt: "Verify BDD",
  });
  await harness.runtime.runTasksToIdle();

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(task?.status, AgentTaskStatuses.Running);
  assert.equal(task?.outcome, undefined);
  assert.equal(task?.result, "worker response without task result");
  assert.equal(task?.steps?.length, 1);
  assert.equal(task?.steps?.[0]?.status, AgentTaskStepStatuses.Completed);
  assert.equal(task?.steps?.[0]?.finalResponse, "worker response without task result");
  assert.equal(harness.terminalTasks.length, 0);
  assert.ok(harness.events.some((event) =>
    SystemEvents.task.stepCompleted.is(event)
    && readReason("data" in event.payload ? event.payload.data : undefined) === "tick_scheduled"
  ));
});

test("WorkerRunner ticks a running task even when no message is queued", async () => {
  let runtime: WorkerRunner | undefined;
  const turnPrompts: string[] = [];
  const harness = createHarness({
    tickIntervalMs: 1,
    runTurn: async (turn) => {
      turnPrompts.push(turn.prompt);
      if (turnPrompts.length === 2) {
        runtime?.requestHumanInput({
          taskId: "task-1",
          request: {
            requestId: "input-1",
            agentId: "verifier",
            taskId: "task-1",
            turnId: "turn-2",
            kind: "prompt_required",
            question: "Need next input?",
            createdAt: new Date().toISOString(),
            status: "pending",
          },
        });
      }
      return completedTurn(`turn-${turnPrompts.length}`);
    },
  });
  runtime = harness.runtime;

  harness.runtime.assignTask({
    taskId: "task-1",
    description: "Observe task",
    subagentType: ScoutAgentRoles.Verifier,
    prompt: "Initial task prompt",
  });

  await waitFor(async () => {
    await harness.runtime.runTasksToIdle();
    return turnPrompts.length >= 2;
  });

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(task?.status, AgentTaskStatuses.WaitingForHumanInput);
  assert.equal(task?.steps?.length, 2);
  assert.equal(turnPrompts[0], "Initial task prompt");
  const tickPrompt = JSON.parse(turnPrompts[1] ?? "{}") as {
    type?: string;
    task?: { taskId?: string; latestStepId?: string };
  };
  assert.equal(tickPrompt.type, "task_tick");
  assert.equal(tickPrompt.task?.taskId, "task-1");
  assert.equal(tickPrompt.task?.latestStepId, "task-1-step-0001");
  assert.ok(harness.events.some((event) =>
    SystemEvents.task.stepCompleted.is(event)
    && readReason("data" in event.payload ? event.payload.data : undefined) === "tick_scheduled"
  ));
  assert.ok(harness.events.some((event) =>
    SystemEvents.task.stepCompleted.is(event)
    && readReason("data" in event.payload ? event.payload.data : undefined) === AgentTaskStatuses.WaitingForHumanInput
  ));
});

test("WorkerRunner accepts explicit outcome as terminal state", () => {
  const harness = createHarness();
  harness.runtime.assignTask({
    taskId: "task-1",
    description: "Verify behavior",
    subagentType: ScoutAgentRoles.Verifier,
    prompt: "Verify BDD",
  });

  const completed = harness.runtime.completeTaskWithOutcome({
    taskId: "task-1",
    outcome: {
      status: AgentTaskOutcomeStatuses.Complete,
      summary: "Scenario is supported.",
      artifactRefs: ["artifact://report"],
      evidenceRefs: ["evidence://line-1"],
    },
  });

  assert.equal(completed.status, AgentTaskStatuses.Complete);
  assert.equal(completed.outcome?.status, AgentTaskOutcomeStatuses.Complete);
  assert.deepEqual(completed.outcome?.evidenceRefs, ["evidence://line-1"]);
  assert.equal(harness.terminalTasks.length, 1);
});

test("WorkerRunner rejects a second task", () => {
  const harness = createHarness();
  harness.runtime.assignTask({
    taskId: "task-1",
    description: "First task",
    subagentType: ScoutAgentRoles.Verifier,
    prompt: "Do first task",
  });

  assert.throws(() => {
    harness.runtime.assignTask({
      taskId: "task-2",
      description: "Second task",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: "Do second task",
    });
  }, /already owns task task-1/);
});

test("WorkerRunner queues a coordinator message back into a waiting task", async () => {
  let runtime: WorkerRunner | undefined;
  const harness = createHarness({
    runTurn: async () => {
      runtime?.requestHumanInput({
        taskId: "task-1",
        request: {
          requestId: "input-1",
          agentId: "verifier",
          taskId: "task-1",
          kind: "prompt_required",
          question: "A or B?",
          createdAt: new Date().toISOString(),
          status: "pending",
        },
      });
      return completedTurn("", "turn-1");
    },
  });
  runtime = harness.runtime;
  harness.runtime.assignTask({
    taskId: "task-1",
    description: "Choose option",
    subagentType: ScoutAgentRoles.Verifier,
    prompt: "Need human input",
  });
  await harness.runtime.runTasksToIdle();

  const updated = harness.runtime.queueMessage({
    taskId: "task-1",
    message: "User picked A.",
  });

  assert.equal(updated.status, AgentTaskStatuses.Running);
  assert.equal(updated.outcome, undefined);
  assert.equal(updated.steps?.[0]?.status, AgentTaskStepStatuses.WaitingForHumanInput);
  assert.equal(updated.steps?.[0]?.humanInputRequest?.requestId, "input-1");
  assert.equal(harness.runtime.snapshot().pendingMessageCount, 1);
});

test("WorkerRunner appends RequestHumanInput turn as a waiting task step", async () => {
  let runtime: WorkerRunner | undefined;
  const harness = createHarness({
    runTurn: async () => {
      runtime?.requestHumanInput({
        taskId: "task-1",
        request: {
          requestId: "input-1",
          agentId: "verifier",
          taskId: "task-1",
          turnId: "turn-1",
          kind: "prompt_required",
          question: "A or B?",
          createdAt: new Date().toISOString(),
          status: "pending",
        },
      });
      return completedTurn("");
    },
  });
  runtime = harness.runtime;

  harness.runtime.assignTask({
    taskId: "task-1",
    description: "Choose option",
    subagentType: ScoutAgentRoles.Verifier,
    prompt: "Need human input",
  });
  await harness.runtime.runTasksToIdle();

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(task?.status, AgentTaskStatuses.WaitingForHumanInput);
  assert.equal(task?.outcome, undefined);
  assert.equal(task?.steps?.length, 1);
  assert.equal(task?.steps?.[0]?.status, AgentTaskStepStatuses.WaitingForHumanInput);
  assert.equal(task?.steps?.[0]?.humanInputRequest?.requestId, "input-1");
  assert.equal(task?.steps?.[0]?.humanInputRequest?.status, "pending");
  assert.equal(harness.terminalTasks.length, 0);
});

test("WorkerRunner stores human input request and response on the interrupted task step", async () => {
  let runtime: WorkerRunner | undefined;
  let turnCount = 0;
  const harness = createHarness({
    runTurn: async () => {
      turnCount += 1;
      if (turnCount === 1) {
        runtime?.requestHumanInput({
          taskId: "task-1",
          request: {
            requestId: "input-1",
            agentId: "verifier",
            taskId: "task-1",
            turnId: "turn-1",
            kind: "prompt_required",
            question: "A or B?",
            createdAt: new Date().toISOString(),
            status: "pending",
          },
        });
        return completedTurn("waiting", "turn-1");
      }
      return completedTurn("resumed", "turn-2");
    },
  });
  runtime = harness.runtime;

  harness.runtime.assignTask({
    taskId: "task-1",
    description: "Choose option",
    subagentType: ScoutAgentRoles.Verifier,
    prompt: "Need human input",
  });
  await harness.runtime.runTasksToIdle();

  harness.runtime.applyHumanInputResponse({
    requestId: "input-1",
    agentId: "verifier",
    taskId: "task-1",
    response: "User picked A.",
    createdAt: new Date().toISOString(),
  });
  harness.runtime.queueMessage({
    taskId: "task-1",
    message: "User picked A.",
  });
  await harness.runtime.runTasksToIdle();

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(task?.steps?.length, 2);
  assert.equal(task?.steps?.[0]?.humanInputRequest?.requestId, "input-1");
  assert.equal(task?.steps?.[0]?.humanInputRequest?.status, "answered");
  assert.equal(task?.steps?.[0]?.humanInputResponse?.requestId, "input-1");
  assert.equal(task?.steps?.[0]?.humanInputResponse?.response, "User picked A.");
  assert.equal(task?.steps?.[1]?.humanInputResponse, undefined);
});

test("AgentTaskBackend keeps latest plan and appends plan records", () => {
  const eventBus = new InMemoryEventBus();
  const store = new AgentTaskStore();
  const registry = new AgentRegistry();
  const agent = createScoutAgentStub("verifier");
  registry.registerAgent(agent);
  store.addTask(taskState({
    taskId: "task-1",
    agentId: "verifier",
  }));
  const backend = new AgentTaskBackend({
    registry,
    taskStore: store,
    eventBus,
    agentProvider: {
      getOrCreateWorker: () => agent,
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
    },
  });
  const firstPlan = planState("turn-1", "first", "inProgress");
  const secondPlan = planState("turn-2", "second", "completed");

  backend.consumeAppServerTimelineEntry(
    agent,
    planTimelineEntry(1, "turn-1"),
    resolvedPlanEntry(firstPlan),
  );
  backend.consumeAppServerTimelineEntry(
    agent,
    planTimelineEntry(2, "turn-2"),
    resolvedPlanEntry(secondPlan),
  );

  const task = store.getTask("task-1");
  assert.equal(task?.plan?.turnId, "turn-2");
  assert.equal(task?.plan?.explanation, "second");
  assert.deepEqual(task?.planRecords?.map((plan) => plan.turnId), ["turn-1", "turn-2"]);
  assert.deepEqual(task?.planRecords?.map((plan) => plan.steps[0]?.status), ["inProgress", "completed"]);
});

function createHarness(input: {
  runTurn?: (turn: ScoutAgentTurnInput) => Promise<ScoutAgentTurnOutcome>;
  tickIntervalMs?: number;
} = {}): {
  runtime: WorkerRunner;
  events: AgentTaskSystemEvent[];
  terminalTasks: AgentTaskState[];
} {
  const eventBus = new InMemoryEventBus();
  const events: AgentTaskSystemEvent[] = [];
  const terminalTasks: AgentTaskState[] = [];
  for (const key of [
    SystemEvents.task.assigned,
    SystemEvents.task.messageQueued,
    SystemEvents.task.humanInputRequested,
    SystemEvents.task.humanInputResponded,
    SystemEvents.task.threadAttached,
    SystemEvents.task.pendingMessagesDrained,
    SystemEvents.task.stepStarted,
    SystemEvents.task.stepCompleted,
    SystemEvents.task.stepOutput,
    SystemEvents.task.terminal,
    SystemEvents.interrupt.raised,
    SystemEvents.interrupt.resolved,
  ]) {
    eventBus.subscribe(key, (event) => {
      events.push(event as AgentTaskSystemEvent);
      if (SystemEvents.task.terminal.is(event)) {
        const task = (event.payload as AgentTaskEventPayload).task;
        if (task) terminalTasks.push(task);
      }
    });
  }
  const thread: AgentThreadSnapshot = {
    threadId: "thread-1",
    spec: {
      role: ScoutAgentRoles.Verifier,
      phases: [ScoutAgentPhases.Verify],
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      contextBundleId: "context-1",
    },
    response: {
      thread: { id: "thread-1" },
    },
  };
  return {
    runtime: new WorkerRunner({
      store: new AgentTaskStore(),
      eventBus,
      tickIntervalMs: input.tickIntervalMs,
      host: {
        agentId: "verifier",
        role: ScoutAgentRoles.Verifier,
        spec: thread.spec,
        logger: createNoopLogger(),
        get threadSnapshot() {
          return thread;
        },
        startThread: async () => thread,
        runTurn: input.runTurn ?? (async () => completedTurn("")),
        setGoal: async () => undefined,
      },
    }),
    events,
    terminalTasks,
  };
}

function createScoutAgentStub(agentId: string): ScoutAgent {
  return {
    agentId,
    role: ScoutAgentRoles.Verifier,
    phases: [ScoutAgentPhases.Verify],
    runner: {
      hasRunningTasks: () => true,
    },
  } as unknown as ScoutAgent;
}

function taskState(input: {
  taskId: string;
  agentId: string;
}): AgentTaskState {
  const now = new Date().toISOString();
  return {
    type: "local_agent",
    taskId: input.taskId,
    agentId: input.agentId,
    role: ScoutAgentRoles.Verifier,
    description: "Verify plan updates",
    initialPrompt: "Verify plan updates",
    status: AgentTaskStatuses.Running,
    isBackgrounded: false,
    createdAt: now,
    updatedAt: now,
  };
}

function planState(turnId: string, explanation: string, status: string): AppServerPlanState {
  return {
    turnId,
    explanation,
    steps: [
      {
        step: "step-one",
        status,
        raw: {
          step: "step-one",
          status,
        },
      },
    ],
    updatedAt: new Date().toISOString(),
  };
}

function planTimelineEntry(seq: number, turnId: string): AppServerTimelineEntry {
  return {
    seq,
    receivedAt: new Date().toISOString(),
    stream: "plan",
    kind: "plan_updated",
    threadId: "thread-1",
    turnId,
  };
}

function resolvedPlanEntry(plan: AppServerPlanState): AppServerResolvedTimelineEntry {
  return {
    entry: planTimelineEntry(0, plan.turnId ?? "turn"),
    plan,
  };
}

function completedTurn(finalResponse: string, turnId = "turn-1"): ScoutAgentTurnOutcome {
  return {
    turn: {
      invocationId: "invocation-1",
      agentId: "verifier",
      role: ScoutAgentRoles.Verifier,
      threadId: "thread-1",
      turnId,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "completed",
    },
    finalResponse,
  };
}

function createNoopLogger(): Logger {
  return {
    registerAgentLogRoot: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}

function readReason(data: unknown): string | undefined {
  return typeof data === "object" && data !== null && "reason" in data
    ? String((data as { reason?: unknown }).reason)
    : undefined;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(await predicate(), true);
}
