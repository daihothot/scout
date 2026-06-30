import test from "node:test";
import assert from "node:assert/strict";
import { ScoutAgentTaskRuntime } from "../../src/agent/task/agent-task-runtime.js";
import { AgentTaskStore } from "../../src/agent/task/agent-task-store.js";
import { ScoutAgentRoles, ScoutAgentPhases } from "../../src/agent/model/types.js";
import type { Logger } from "../../src/core/logging/index.js";
import type {
  AgentTaskState,
} from "../../src/agent/task/types.js";
import type { AgentTaskSystemEvent } from "../../src/agent/task/task-events.js";
import {
  InMemoryEventBus,
  SystemEvents,
} from "../../src/core/events/index.js";
import type {
  ScoutAgentTurnInput,
  ScoutAgentTurnOutcome,
} from "../../src/agent/core/scout-agent.js";
import type { AgentThreadRecord } from "../../src/agent/model/types.js";

test("ScoutAgentTaskRuntime waits for coordinator when a turn completes without terminal domain state", async () => {
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
  assert.equal(task?.status, "waiting_for_coordinator");
  assert.equal(task?.outcome, undefined);
  assert.equal(task?.steps?.length, 1);
  assert.equal(task?.steps?.[0]?.status, "waiting_for_coordinator");
  assert.deepEqual(task?.steps?.[0]?.protocolWarnings, ["Agent turn completed without a terminal domain state or RequestHumanInput."]);
  assert.equal(harness.terminalTasks.length, 0);
  assert.ok(harness.events.some((event) =>
    SystemEvents.task.stepCompleted.is(event)
    && readReason("data" in event.payload ? event.payload.data : undefined) === "waiting_for_coordinator"
  ));
});

test("ScoutAgentTaskRuntime accepts explicit outcome as terminal state", () => {
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

test("ScoutAgentTaskRuntime queues user input response back into waiting task", () => {
  const harness = createHarness();
  harness.runtime.assignTask({
    taskId: "task-1",
    description: "Choose option",
    subagentType: ScoutAgentRoles.Verifier,
    prompt: "Need user input",
  });
  harness.runtime.requestUserInput({
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
  assert.equal(updated.userInputRequest, undefined);
  assert.equal(updated.outcome, undefined);
  assert.equal(updated.humanInputRequests?.[0]?.status, "pending");
  assert.equal(harness.runtime.snapshot().pendingMessageCount, 1);
});

test("ScoutAgentTaskRuntime records RequestHumanInput turn as a waiting task step", async () => {
  let runtime: ScoutAgentTaskRuntime | undefined;
  const harness = createHarness({
    runTurn: async () => {
      runtime?.requestUserInput({
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
    prompt: "Need user input",
  });
  await harness.runtime.runTasksToIdle();

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(task?.status, "waiting_for_human_input");
  assert.equal(task?.outcome, undefined);
  assert.equal(task?.userInputRequest?.requestId, "input-1");
  assert.equal(task?.humanInputRequests?.[0]?.status, "pending");
  assert.equal(task?.steps?.length, 1);
  assert.equal(task?.steps?.[0]?.status, "waiting_for_human_input");
  assert.equal(harness.terminalTasks.length, 0);
});

function createHarness(input: {
  runTurn?: (turn: ScoutAgentTurnInput) => Promise<ScoutAgentTurnOutcome>;
} = {}): {
  runtime: ScoutAgentTaskRuntime;
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
        const task = (event as AgentTaskSystemEvent).payload.task;
        if (task) terminalTasks.push(task);
      }
    });
  }
  const thread: AgentThreadRecord = {
    role: ScoutAgentRoles.Verifier,
    phases: [ScoutAgentPhases.Verify],
    threadId: "thread-1",
    request: {
      role: ScoutAgentRoles.Verifier,
      phases: [ScoutAgentPhases.Verify],
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      contextBundleId: "context-1",
    },
    effective: {},
    response: {},
  };
  return {
    runtime: new ScoutAgentTaskRuntime({
      store: new AgentTaskStore(),
      eventBus,
      host: {
        agentId: "verifier",
        role: ScoutAgentRoles.Verifier,
        spec: thread.request,
        logger: createNoopLogger(),
        get threadRecord() {
          return thread;
        },
        startWithPreflight: async () => ({
          thread,
          preflight: {
            agentId: "verifier",
            role: ScoutAgentRoles.Verifier,
            threadId: thread.threadId,
            checkedAt: new Date().toISOString(),
            result: {
              status: "passed",
              threadId: thread.threadId,
            },
          },
        }),
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
