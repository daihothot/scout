import test from "node:test";
import assert from "node:assert/strict";
import { ScoutAgentTaskRuntime } from "../../src/agent/scout-agent-task.js";
import { ScoutAgentRoles, ScoutAgentPhases } from "../../src/agent/types.js";
import type { Logger } from "../../src/core/logging/index.js";
import type {
  AgentTaskState,
  AgentTaskStateEvent,
} from "../../src/agent/task/types.js";
import type {
  ScoutAgentTurnInput,
  ScoutAgentTurnOutcome,
} from "../../src/agent/scout-agent.js";
import type { AgentThreadRecord } from "../../src/agent/types.js";

test("ScoutAgentTaskRuntime fails a task when a turn completes without TaskResult", async () => {
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
  assert.equal(task?.status, "failed");
  assert.equal(task?.outcome?.status, "failed");
  assert.equal(task?.error, "Agent turn completed without TaskResult.");
  assert.equal(harness.terminalTasks.length, 1);
  assert.equal(harness.terminalTasks[0]?.taskId, "task-1");
  assert.ok(harness.events.some((event) => event.event === "task_missing_task_result"));
});

test("ScoutAgentTaskRuntime accepts explicit TaskResult outcome as terminal state", () => {
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
    },
  });

  const updated = harness.runtime.queueMessage({
    taskId: "task-1",
    message: "User picked A.",
  });

  assert.equal(updated.status, "running");
  assert.equal(updated.userInputRequest, undefined);
  assert.equal(updated.outcome, undefined);
  assert.equal(harness.runtime.snapshot().pendingMessageCount, 1);
});

function createHarness(input: {
  runTurn?: (turn: ScoutAgentTurnInput) => Promise<ScoutAgentTurnOutcome>;
} = {}): {
  runtime: ScoutAgentTaskRuntime;
  events: Array<{ event: AgentTaskStateEvent; task: AgentTaskState; data?: unknown }>;
  terminalTasks: AgentTaskState[];
} {
  const events: Array<{ event: AgentTaskStateEvent; task: AgentTaskState; data?: unknown }> = [];
  const terminalTasks: AgentTaskState[] = [];
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
        emitTaskState: (event, task, data) => {
          events.push({ event, task, data });
        },
        emitTaskTerminal: (task) => {
          terminalTasks.push(task);
        },
        emitUserInputRequested: () => undefined,
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
