import test from "node:test";
import assert from "node:assert/strict";
import { AgentTaskBackend } from "../../src/agent/backend/agent-task-backend.js";
import { AgentRegistry } from "../../src/agent/core/agent-registry.js";
import { WorkerRunner } from "../../src/agent/runner/worker/worker-runner.js";
import { AgentTaskStore } from "../../src/agent/task/agent-task-store.js";
import { ScoutAgentRoles, ScoutAgentPhases } from "../../src/agent/thread/types.js";
import type { Logger } from "../../src/core/logging/index.js";
import type {
  AgentTaskState,
  AssignAgentTaskInput,
} from "../../src/agent/task/types.js";
import {
  AgentTaskOutcomeStatuses,
  AgentTaskStatuses,
  AgentTaskStepStatuses,
} from "../../src/agent/task/types.js";
import { attachments } from "../../src/agent/context/index.js";
import { agent } from "../../src/agent/context/agent-attachments.js";
import { WorkerContextTags } from "../../src/agent/runner/worker/worker-attachments.js";
import type {
  AgentTaskEventPayload,
  AgentTaskEvent,
} from "../../src/agent/task/task-events.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import type {
  ScoutAgentTurnInput,
  ScoutAgentTurnOutcome,
  ScoutAgent,
} from "../../src/agent/core/scout-agent.js";
import type { WorkerAgent } from "../../src/agent/roles/worker-agent.js";
import type { AgentThreadSnapshot } from "../../src/agent/thread/types.js";
import type {
  AppServerPlanState,
  AppServerResolvedTimelineEntry,
  AppServerThreadGoalState,
  AppServerTimelineEntry,
} from "../../src/agent-server/codex/app-server-event-store.js";

test("WorkerRunner keeps task running and schedules a tick when a turn completes without terminal outcome", async () => {
  let runtime: WorkerRunner | undefined;
  let turnCount = 0;
  const harness = createHarness({
    taskInput: {
      taskId: "task-1",
      description: "Verify behavior",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Verify BDD"),
    },
    runTurn: async () => {
      turnCount += 1;
      if (turnCount === 2) {
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
      return completedTurn(`worker response ${turnCount}`, `turn-${turnCount}`);
    },
  });
  runtime = harness.runtime;

  await harness.runtime.runTasksToIdle();
  await waitFor(() =>
    harness.runtime.getTaskSnapshot("task-1")?.status === AgentTaskStatuses.WaitingForHumanInput
  );

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(task?.status, AgentTaskStatuses.WaitingForHumanInput);
  assert.equal(task?.outcome, undefined);
  assert.equal(task?.result, "worker response 2");
  assert.equal(task?.steps?.length, 2);
  assert.equal(task?.steps?.[0]?.status, AgentTaskStepStatuses.Completed);
  assert.equal(task?.steps?.[0]?.finalResponse, "worker response 1");
  assert.equal(task?.steps?.[1]?.status, AgentTaskStepStatuses.WaitingForHumanInput);
  assert.equal(harness.terminalTasks.length, 0);
  assert.ok(harness.events.some((event) =>
    AgentEvents.task.stepCompleted.is(event)
    && readReason("data" in event.payload ? event.payload.data : undefined) === "tick_scheduled"
  ));
});

test("WorkerRunner ticks a running task even when no message is queued", async () => {
  let runtime: WorkerRunner | undefined;
  const turnPrompts: string[] = [];
  const harness = createHarness({
    taskInput: {
      taskId: "task-1",
      description: "Observe task",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Initial task prompt"),
    },
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

  await waitFor(async () => {
    await harness.runtime.runTasksToIdle();
    return turnPrompts.length >= 2;
  });

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(task?.status, AgentTaskStatuses.WaitingForHumanInput);
  assert.equal(task?.steps?.length, 2);
  assert.match(turnPrompts[0] ?? "", /use-update-tools/);
  assert.match(turnPrompts[0] ?? "", /Initial task prompt/);
  assert.match(turnPrompts[1] ?? "", /use-update-tools/);
  const tickPromptBody = attachments.readTagBlock(
    turnPrompts[1] ?? "",
    WorkerContextTags.TaskTick,
  )[0]?.body;
  const tickPrompt = JSON.parse(tickPromptBody ?? "{}") as {
    type?: string;
    task?: { taskId?: string; latestStepId?: string };
  };
  assert.equal(tickPrompt.type, "task_tick");
  assert.equal(tickPrompt.task?.taskId, "task-1");
  assert.equal(tickPrompt.task?.latestStepId, "task-1-step-0001");
  assert.ok(harness.events.some((event) =>
    AgentEvents.task.stepCompleted.is(event)
    && readReason("data" in event.payload ? event.payload.data : undefined) === "tick_scheduled"
  ));
  assert.ok(harness.events.some((event) =>
    AgentEvents.task.stepCompleted.is(event)
    && readReason("data" in event.payload ? event.payload.data : undefined) === AgentTaskStatuses.WaitingForHumanInput
  ));
});

test("WorkerRunner accepts explicit outcome as terminal state", () => {
  const harness = createHarness({
    taskInput: {
      taskId: "task-1",
      description: "Verify behavior",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Verify BDD"),
    },
  });

  const completed = harness.runtime.completeTaskWithOutcome({
    outcome: {
      taskId: "task-1",
      status: AgentTaskOutcomeStatuses.Complete,
      summary: "Scenario is supported.",
    },
  });

  assert.equal(completed.status, AgentTaskStatuses.Complete);
  assert.equal(completed.outcome?.taskId, "task-1");
  assert.equal(completed.outcome?.status, AgentTaskOutcomeStatuses.Complete);
  assert.equal(harness.terminalTasks.length, 1);
});

test("WorkerRunner initializes and registers its single task during construction", () => {
  const harness = createHarness({
    taskInput: {
      description: "First task",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Do first task"),
    },
  });
  const task = harness.runtime.snapshot().activeTask;

  assert.equal(task?.taskId, "verifier-task-0001");
  assert.equal(task?.taskSequence, 1);
  assert.equal(task?.description, "First task");
});

test("WorkerRunner keeps plain messages queued while waiting for human input", async () => {
  let runtime: WorkerRunner | undefined;
  let turnCount = 0;
  const harness = createHarness({
    taskInput: {
      taskId: "task-1",
      description: "Choose option",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Need human input"),
    },
    runTurn: async () => {
      turnCount += 1;
      const requestId = turnCount === 1 ? "input-1" : "input-2";
      runtime?.requestHumanInput({
        taskId: "task-1",
        request: {
          requestId,
          agentId: "verifier",
          taskId: "task-1",
          kind: "prompt_required",
          question: "A or B?",
          createdAt: new Date().toISOString(),
          status: "pending",
        },
      });
      return completedTurn("", `turn-${turnCount}`);
    },
  });
  runtime = harness.runtime;
  await harness.runtime.runTasksToIdle();

  const updated = harness.runtime.queueMessage({
    taskId: "task-1",
    message: "User picked A.",
  });

  assert.equal(updated.status, AgentTaskStatuses.WaitingForHumanInput);
  assert.equal(updated.outcome, undefined);
  assert.equal(updated.steps?.[0]?.status, AgentTaskStepStatuses.WaitingForHumanInput);
  assert.equal(updated.steps?.[0]?.humanInputRequest?.requestId, "input-1");
  assert.equal(updated.steps?.[0]?.humanInputResponse, undefined);
  await harness.runtime.runTasksToIdle();
  const stillWaiting = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(stillWaiting?.status, AgentTaskStatuses.WaitingForHumanInput);
  assert.equal(stillWaiting?.steps?.[0]?.humanInputResponse, undefined);
});

test("WorkerRunner appends RequestHumanInput turn as a waiting task step", async () => {
  let runtime: WorkerRunner | undefined;
  const harness = createHarness({
    taskInput: {
      taskId: "task-1",
      description: "Choose option",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Need human input"),
    },
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
    taskInput: {
      taskId: "task-1",
      description: "Choose option",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Need human input"),
    },
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
      if (turnCount === 2) {
        runtime?.requestHumanInput({
          taskId: "task-1",
          request: {
            requestId: "input-2",
            agentId: "verifier",
            taskId: "task-1",
            turnId: "turn-2",
            kind: "prompt_required",
            question: "Need follow-up?",
            createdAt: new Date().toISOString(),
            status: "pending",
          },
        });
      }
      return completedTurn("resumed", "turn-2");
    },
  });
  runtime = harness.runtime;

  await harness.runtime.runTasksToIdle();

  harness.runtime.queueMessage({
    taskId: "task-1",
    message: agent.turn.human_response("User picked A."),
  });
  await harness.runtime.runTasksToIdle();
  await waitFor(() =>
    harness.runtime.getTaskSnapshot("task-1")?.steps?.[0]?.humanInputResponse?.response === "User picked A."
  );

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(task?.steps?.length, 2);
  assert.equal(task?.steps?.[0]?.humanInputRequest?.requestId, "input-1");
  assert.equal(task?.steps?.[0]?.humanInputRequest?.status, "answered");
  assert.equal(task?.steps?.[0]?.humanInputResponse?.requestId, "input-1");
  assert.equal(task?.steps?.[0]?.humanInputResponse?.response, "User picked A.");
  assert.equal(task?.steps?.[1]?.humanInputResponse, undefined);
});

test("AgentTaskBackend reduces app-server plan and goal timeline entries into task state", () => {
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
    logger: {
      info: () => undefined,
      warn: () => undefined,
    },
  });
  const firstPlan = planState("turn-1", "first", "inProgress");
  const secondPlan = planState("turn-2", "second", "completed");
  const goal = goalState("Verify checkout flow", "active");

  backend.handleAppServerTimelineEntry(
    agent,
    planTimelineEntry(1, "turn-1"),
    () => resolvedPlanEntry(firstPlan),
  );
  backend.handleAppServerTimelineEntry(
    agent,
    planTimelineEntry(2, "turn-2"),
    () => resolvedPlanEntry(secondPlan),
  );
  backend.handleAppServerTimelineEntry(
    agent,
    goalTimelineEntry(3),
    () => resolvedGoalEntry(goal),
  );

  const task = store.getTask("task-1");
  assert.equal(task?.plan?.turnId, "turn-2");
  assert.equal(task?.plan?.explanation, "second");
  assert.deepEqual(task?.planRecords?.map((plan) => plan.turnId), ["turn-1", "turn-2"]);
  assert.deepEqual(task?.planRecords?.map((plan) => plan.steps[0]?.status), ["inProgress", "completed"]);
  assert.equal(task?.goal?.objective, "Verify checkout flow");
  assert.equal(task?.goal?.status, "active");
});

function createHarness(input: {
  taskInput?: AssignAgentTaskInput;
  runTurn?: (turn: ScoutAgentTurnInput) => Promise<ScoutAgentTurnOutcome>;
} = {}): {
  runtime: WorkerRunner;
  events: AgentTaskEvent[];
  terminalTasks: AgentTaskState[];
} {
  const eventBus = new InMemoryEventBus();
  const events: AgentTaskEvent[] = [];
  const terminalTasks: AgentTaskState[] = [];
  for (const key of [
    AgentEvents.task.assigned,
    AgentEvents.task.messageQueued,
    AgentEvents.task.humanInputRequested,
    AgentEvents.task.humanInputResponded,
    AgentEvents.task.threadAttached,
    AgentEvents.task.pendingMessagesDrained,
    AgentEvents.task.stepStarted,
    AgentEvents.task.stepCompleted,
    AgentEvents.task.stepOutput,
    AgentEvents.task.terminal,
    AgentEvents.interrupt.raised,
    AgentEvents.interrupt.resolved,
  ]) {
    eventBus.subscribe(key, (event) => {
      events.push(event as AgentTaskEvent);
      if (AgentEvents.task.terminal.is(event)) {
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
      taskInput: input.taskInput,
      host: {
        agentId: "verifier",
        role: ScoutAgentRoles.Verifier,
        spec: thread.spec,
        logger: createNoopLogger(),
        get threadSnapshot() {
          return thread;
        },
        runTurn: input.runTurn ?? (async () => completedTurn("")),
        setGoal: async () => undefined,
      },
    }),
    events,
    terminalTasks,
  };
}

function createScoutAgentStub(agentId: string): WorkerAgent {
  return {
    agentId,
    role: ScoutAgentRoles.Verifier,
    phases: [ScoutAgentPhases.Verify],
    runner: {
      hasRunningTasks: () => true,
    },
  } as unknown as WorkerAgent;
}

function taskState(input: {
  taskId: string;
  agentId: string;
}): AgentTaskState {
  const now = new Date().toISOString();
  return {
    type: "local_agent",
    taskId: input.taskId,
    taskSequence: 1,
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

function goalState(objective: string, status: string): AppServerThreadGoalState {
  return {
    threadId: "thread-1",
    objective,
    status,
    raw: {
      threadId: "thread-1",
      objective,
      status,
    },
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

function goalTimelineEntry(seq: number): AppServerTimelineEntry {
  return {
    seq,
    receivedAt: new Date().toISOString(),
    stream: "state",
    kind: "goal_updated",
    threadId: "thread-1",
  };
}

function resolvedPlanEntry(plan: AppServerPlanState): AppServerResolvedTimelineEntry {
  return {
    entry: planTimelineEntry(0, plan.turnId ?? "turn"),
    plan,
  };
}

function resolvedGoalEntry(goal: AppServerThreadGoalState): AppServerResolvedTimelineEntry {
  return {
    entry: goalTimelineEntry(0),
    goal,
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
