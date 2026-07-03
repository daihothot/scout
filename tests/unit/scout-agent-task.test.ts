import test from "node:test";
import assert from "node:assert/strict";
import { WorkerRunner } from "../../src/agent/runner/worker-runner.js";
import { AgentTaskStore } from "../../src/agent/task/agent-task-store.js";
import { ScoutAgentRoles, ScoutAgentPhases } from "../../src/agent/thread/types.js";
import type { Logger } from "../../src/core/logging/index.js";
import type {
  AgentTaskState,
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
} from "../../src/agent/core/scout-agent.js";
import type { AgentThreadSnapshot } from "../../src/agent/thread/types.js";

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
  assert.equal(task?.status, "running");
  assert.equal(task?.outcome, undefined);
  assert.equal(task?.result, "worker response without task result");
  assert.equal(task?.steps?.length, 1);
  assert.equal(task?.steps?.[0]?.status, "completed");
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
  assert.equal(task?.status, "waiting_for_human_input");
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
    && readReason("data" in event.payload ? event.payload.data : undefined) === "waiting_for_human_input"
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
      status: "complete",
      summary: "Scenario is supported.",
      artifactRefs: ["artifact://report"],
      evidenceRefs: ["evidence://line-1"],
    },
  });

  assert.equal(completed.status, "complete");
  assert.equal(completed.outcome?.status, "complete");
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

test("WorkerRunner queues human input response back into waiting task", () => {
  const harness = createHarness();
  harness.runtime.assignTask({
    taskId: "task-1",
    description: "Choose option",
    subagentType: ScoutAgentRoles.Verifier,
    prompt: "Need human input",
  });
  harness.runtime.requestHumanInput({
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

  const updated = harness.runtime.queueMessage({
    taskId: "task-1",
    message: "User picked A.",
  });

  assert.equal(updated.status, "running");
  assert.equal(updated.humanInputRequest, undefined);
  assert.equal(updated.outcome, undefined);
  assert.equal(updated.humanInputRequests?.[0]?.status, "pending");
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
  assert.equal(task?.status, "waiting_for_human_input");
  assert.equal(task?.outcome, undefined);
  assert.equal(task?.humanInputRequest?.requestId, "input-1");
  assert.equal(task?.humanInputRequests?.[0]?.status, "pending");
  assert.equal(task?.steps?.length, 1);
  assert.equal(task?.steps?.[0]?.status, "waiting_for_human_input");
  assert.equal(harness.terminalTasks.length, 0);
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

function completedTurn(finalResponse: string): ScoutAgentTurnOutcome {
  return {
    turn: {
      invocationId: "invocation-1",
      agentId: "verifier",
      role: ScoutAgentRoles.Verifier,
      threadId: "thread-1",
      turnId: "turn-1",
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
