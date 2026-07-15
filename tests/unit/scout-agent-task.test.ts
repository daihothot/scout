import test from "node:test";
import assert from "node:assert/strict";
import { AgentTaskBackend } from "../../src/agent/backend/agent-task-backend.js";
import { AgentRegistry } from "../../src/agent/core/agent-registry.js";
import { WorkerRunner } from "../../src/agent/runner/worker/worker-runner.js";
import { AgentTaskStore } from "../../src/agent/task/agent-task-store.js";
import { ScoutAgentRoles, ScoutAgentPhases } from "../../src/agent/thread/types.js";
import type {
  AgentTaskStepToolCall,
  AgentTaskState,
  AssignAgentTaskInput,
} from "../../src/agent/task/types.js";
import {
  AgentTaskStatuses,
  AgentTaskStepStatuses,
} from "../../src/agent/task/types.js";
import { attachments } from "../../src/agent/context/index.js";
import {
  agent,
} from "../../src/agent/context/agent-attachments.js";
import { WorkerContextTags } from "../../src/agent/runner/worker/worker-attachments.js";
import { InMemoryEventBus, type ScoutEvent } from "../../src/core/events/index.js";
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
import { NoopRuntimeInteractionPort } from "../../src/interaction/protocol/port.js";
import {
  installRunScope,
  RunScope,
} from "../../src/run/run-scope.js";
import { AGENT_SEND_MESSAGE_TOOL_NAMESPACE } from "../../src/agent/tools/agent-tools.js";

test("WorkerRunner keeps ticking until a human-input request yields the loop", async () => {
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
      return completedTurn(
        `worker response ${turnCount}`,
        `turn-${turnCount}`,
        turnCount === 2
          ? [{
            namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
            tool: "SendMessage",
            arguments: {
              to: ScoutAgentRoles.Coordinator,
              message: agent.turn.wait_for_human_request("Need human input."),
            },
            success: true,
          }]
          : [],
      );
    },
  });

  await waitFor(async () => {
    await harness.runtime.runTasksToIdle();
    return turnCount >= 2;
  });

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(turnCount, 2);
  assert.equal(task?.status, AgentTaskStatuses.Running);
  assert.equal(task?.result, "worker response 2");
  assert.equal(task?.steps?.length, 2);
  assert.equal(task?.steps?.[0]?.status, AgentTaskStepStatuses.Completed);
  assert.equal(task?.steps?.[0]?.finalResponse, "worker response 1");
  assert.equal(task?.steps?.[1]?.status, AgentTaskStepStatuses.Completed);
  assert.deepEqual(task?.steps?.[1]?.humanInputRequest, { body: "Need human input." });
  assert.equal(harness.terminalTasks.length, 0);
  assert.ok(harness.events.some((event) =>
    AgentEvents.task.stepCompleted.is(event)
    && (event.payload as AgentTaskState).status === AgentTaskStatuses.Running
  ));
});

test("WorkerRunner ticks a running task even when no message is queued", async () => {
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
      return completedTurn(
        `turn-${turnPrompts.length}`,
        `turn-${turnPrompts.length}`,
        turnPrompts.length === 2
          ? [{
            namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
            tool: "SendMessage",
            arguments: {
              to: ScoutAgentRoles.Coordinator,
              message: agent.turn.wait_for_human_request("Need human input."),
            },
            success: true,
          }]
          : [],
      );
    },
  });

  await waitFor(async () => {
    await harness.runtime.runTasksToIdle();
    return turnPrompts.length >= 2;
  });

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(task?.status, AgentTaskStatuses.Running);
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
    && (event.payload as AgentTaskState).status === AgentTaskStatuses.Running
  ));
  assert.deepEqual(task?.steps?.[1]?.humanInputRequest, { body: "Need human input." });
});

test("WorkerRunner records a wait-request SendMessage without changing task status", async () => {
  let turnCount = 0;
  const harness = createHarness({
    taskInput: {
      taskId: "task-1",
      description: "Inspect explicit lifecycle commands",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Inspect lifecycle"),
    },
    runTurn: async () => {
      turnCount += 1;
      if (turnCount === 2) {
        return completedTurn("waiting", "turn-2", [{
          namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
          tool: "SendMessage",
          arguments: {
            to: ScoutAgentRoles.Coordinator,
            message: agent.turn.wait_for_human_request("Need human input."),
          },
          success: true,
        }]);
      }
      return {
        ...completedTurn("ordinary message sent", "turn-1"),
        toolCalls: [{
          namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
          tool: "SendMessage",
          arguments: {
            to: ScoutAgentRoles.Coordinator,
            message: agent.turn.task_outcome("This must not submit the task."),
          },
          success: true,
        }],
      };
    },
  });

  await waitFor(async () => {
    await harness.runtime.runTasksToIdle();
    return turnCount >= 2;
  });

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(turnCount, 2);
  assert.equal(task?.status, AgentTaskStatuses.Running);
  assert.deepEqual(task?.steps?.[1]?.humanInputRequest, { body: "Need human input." });
  assert.equal(harness.events.some((event) => AgentEvents.task.done.is(event)), false);
});

test("WorkerRunner enters done from SubmitTask and resumes the same task from a message", async () => {
  let turnCount = 0;
  const turnPrompts: string[] = [];
  const harness = createHarness({
    taskInput: {
      taskId: "task-1",
      description: "Verify behavior",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Verify BDD"),
    },
    runTurn: async (turn, runtime) => {
      turnCount += 1;
      turnPrompts.push(turn.prompt);
      runtime.submitTask();
      return completedTurn(`worker response ${turnCount}`, `turn-${turnCount}`);
    },
  });

  await harness.runtime.runTasksToIdle();
  assert.equal(harness.runtime.getTaskSnapshot("task-1")?.status, AgentTaskStatuses.Done);
  assert.equal(harness.terminalTasks.length, 0);
  assert.ok(harness.events.some((event) => AgentEvents.task.done.is(event)));

  harness.runtime.queueMessage({
    taskId: "task-1",
    message: agent.turn.message("Please correct the evidence refs."),
  });
  await harness.runtime.runTasksToIdle();

  const resumed = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(resumed?.status, AgentTaskStatuses.Done);
  assert.equal(resumed?.steps?.length, 2);
  assert.match(turnPrompts[1] ?? "", /<message>\nPlease correct the evidence refs\.\n<\/message>/);
});

test("WorkerRunner archive waits for the active turn before deleting task state", async () => {
  let releaseTurn: (() => void) | undefined;
  let markTurnStarted: (() => void) | undefined;
  const turnStarted = new Promise<void>((resolve) => {
    markTurnStarted = resolve;
  });
  const turnReleased = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const harness = createHarness({
    taskInput: {
      taskId: "task-1",
      description: "Verify behavior",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Verify BDD"),
    },
    runTurn: async () => {
      markTurnStarted?.();
      await turnReleased;
      return completedTurn("worker response");
    },
  });

  await turnStarted;
  let archiveSettled = false;
  const archivePromise = harness.runtime.archiveTask("task-1").then((task) => {
    archiveSettled = true;
    return task;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(archiveSettled, false);

  releaseTurn?.();
  const archived = await archivePromise;

  assert.equal(archived.taskId, "task-1");
  assert.equal(harness.runtime.getTaskSnapshot("task-1"), undefined);
  assert.equal(harness.runtime.snapshot().activeTask, undefined);
  assert.ok(harness.events.some((event) => AgentEvents.task.archived.is(event)));
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

test("WorkerRunner rejects an untagged message without starting another step", async () => {
  const harness = createHarness({
    taskInput: {
      taskId: "task-1",
      description: "Choose option",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Need human input"),
    },
    runTurn: async () => {
      return completedTurn("waiting", "turn-1", [{
        namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
        tool: "SendMessage",
        arguments: {
          to: ScoutAgentRoles.Coordinator,
          message: agent.turn.wait_for_human_request("Need human input."),
        },
        success: true,
      }]);
    },
  });
  await harness.runtime.runTasksToIdle();

  assert.throws(() => harness.runtime.queueMessage({
    taskId: "task-1",
    message: "User picked A.",
  }), /Invalid attachment block/);

  await harness.runtime.runTasksToIdle();
  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(task?.status, AgentTaskStatuses.Running);
  assert.equal(task?.steps?.length, 1);
  assert.equal(task?.steps?.[0]?.status, AgentTaskStepStatuses.Completed);
  assert.equal(harness.runtime.snapshot().pendingMessageCount, 0);
});

test("WorkerRunner serves an ordinary message after a request step yields", async () => {
  let turnCount = 0;
  const turnPrompts: string[] = [];
  const harness = createHarness({
    taskInput: {
      taskId: "task-1",
      description: "Choose option",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Need human input"),
    },
    runTurn: async (turn, runtime) => {
      turnCount += 1;
      turnPrompts.push(turn.prompt);
      if (turnCount === 1) {
        return completedTurn("waiting", "turn-1", [{
          namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
          tool: "SendMessage",
          arguments: {
            to: ScoutAgentRoles.Coordinator,
            message: agent.turn.wait_for_human_request("Need human input."),
          },
          success: true,
        }]);
      }
      runtime.submitTask();
      return completedTurn("continued", "turn-2");
    },
  });

  await harness.runtime.runTasksToIdle();
  assert.equal(
    harness.runtime.getTaskSnapshot("task-1")?.status,
    AgentTaskStatuses.Running,
  );

  harness.runtime.queueMessage({
    taskId: "task-1",
    message: agent.turn.message("Continue without a human response tag."),
  });
  await harness.runtime.runTasksToIdle();

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(turnCount, 2);
  assert.equal(task?.status, AgentTaskStatuses.Done);
  assert.match(
    turnPrompts[1] ?? "",
    /<message>\nContinue without a human response tag\.\n<\/message>/,
  );
});

test("WorkerRunner records a human-input request on its completed step", async () => {
  const harness = createHarness({
    taskInput: {
      taskId: "task-1",
      description: "Choose option",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Need human input"),
    },
    runTurn: async () => {
      return completedTurn("waiting", "turn-1", [{
        namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
        tool: "SendMessage",
        arguments: {
          to: ScoutAgentRoles.Coordinator,
          message: agent.turn.wait_for_human_request("Need human input."),
        },
        success: true,
      }]);
    },
  });

  await harness.runtime.runTasksToIdle();

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(task?.status, AgentTaskStatuses.Running);
  assert.equal(task?.steps?.length, 1);
  assert.equal(task?.steps?.[0]?.status, AgentTaskStepStatuses.Completed);
  assert.deepEqual(task?.steps?.[0]?.humanInputRequest, { body: "Need human input." });
  assert.equal(task?.steps?.[0]?.humanInputResponse, undefined);
  assert.equal(harness.terminalTasks.length, 0);
});

test("WorkerRunner records a delayed human response on the step that consumes it", async () => {
  let turnCount = 0;
  const turnPrompts: string[] = [];
  const harness = createHarness({
    taskInput: {
      taskId: "task-1",
      description: "Choose option",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Need human input"),
    },
    runTurn: async (turn, runtime) => {
      turnCount += 1;
      turnPrompts.push(turn.prompt);
      if (turnCount <= 2) {
        return completedTurn(`request-${turnCount}`, `turn-${turnCount}`, [{
          namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
          tool: "SendMessage",
          arguments: {
            to: ScoutAgentRoles.Coordinator,
            message: agent.turn.wait_for_human_request(`Need human input ${turnCount}.`),
          },
          success: true,
        }]);
      }
      runtime.submitTask();
      return completedTurn("resumed", `turn-${turnCount}`);
    },
  });

  await harness.runtime.runTasksToIdle();

  harness.runtime.queueMessage({
    taskId: "task-1",
    message: agent.turn.message("Please clarify the requested account."),
  });
  await harness.runtime.runTasksToIdle();

  harness.runtime.queueMessage({
    taskId: "task-1",
    message: agent.turn.human_response("User picked A."),
  });
  await harness.runtime.runTasksToIdle();

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(task?.steps?.length, 3);
  assert.equal(task?.status, AgentTaskStatuses.Done);
  assert.deepEqual(task?.steps?.[0]?.humanInputRequest, { body: "Need human input 1." });
  assert.equal(task?.steps?.[0]?.humanInputResponse, undefined);
  assert.deepEqual(task?.steps?.[1]?.humanInputRequest, { body: "Need human input 2." });
  assert.equal(task?.steps?.[1]?.humanInputResponse, undefined);
  assert.equal(task?.steps?.[2]?.humanInputRequest, undefined);
  assert.deepEqual(task?.steps?.[2]?.humanInputResponse, { body: "User picked A." });
  assert.match(turnPrompts[2] ?? "", /<human-response>\nUser picked A\.\n<\/human-response>/);
  assert.ok(harness.events.some((event) =>
    AgentEvents.task.stepStarted.is(event)
    && (event.payload as AgentTaskState).status === AgentTaskStatuses.Running
    && (event.payload as AgentTaskState).steps?.length === 3
  ));
});

test("AgentTaskBackend reduces app-server plan and goal timeline entries into task state", (t) => {
  const eventBus = new InMemoryEventBus();
  const runId = "run-task-backend-test";
  const scope = new RunScope({
    runId,
    repoRoot: "/repo",
    logger: {} as RunScope["logger"],
    eventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: {
      domainId: "test",
      name: "test",
      dynamicToolsForRole: () => [],
    },
    terminate: async () => undefined,
  });
  const releaseRunScope = installRunScope(scope);
  t.after(releaseRunScope);
  const store = scope.taskStore;
  const registry = scope.agentRegistry;
  const agent = createScoutAgentStub("verifier");
  registry.registerAgent(agent);
  store.addTask(taskState({
    taskId: "task-1",
    agentId: "verifier",
  }));
  const backend = new AgentTaskBackend();
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
  runTurn?: (turn: ScoutAgentTurnInput, runtime: WorkerRunner) => Promise<ScoutAgentTurnOutcome>;
} = {}): {
  runtime: WorkerRunner;
  events: ScoutEvent[];
  terminalTasks: AgentTaskState[];
} {
  const eventBus = new InMemoryEventBus();
  const events: ScoutEvent[] = [];
  const terminalTasks: AgentTaskState[] = [];
  for (const key of [
    AgentEvents.task.assigned,
    AgentEvents.task.messageQueued,
    AgentEvents.task.done,
    AgentEvents.task.archived,
    AgentEvents.task.threadAttached,
    AgentEvents.task.pendingMessagesDrained,
    AgentEvents.task.stepStarted,
    AgentEvents.task.stepCompleted,
    AgentEvents.task.stepOutput,
    AgentEvents.task.terminal,
  ]) {
    eventBus.subscribe(key, (event) => {
      events.push(event);
      if (AgentEvents.task.terminal.is(event)) {
        terminalTasks.push(event.payload as AgentTaskState);
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
      model: {
        id: "gpt-5.5",
        provider: "GuruOpenAI",
        reasoningEffort: "high",
        reasoningSummary: "concise",
      },
    },
    response: {
      thread: { id: "thread-1" },
    },
  };
  let runtime: WorkerRunner;
  runtime = new WorkerRunner({
      store: new AgentTaskStore(),
      eventBus,
      taskSequence: 1,
      taskInput: input.taskInput,
      host: {
        agentId: "verifier",
        role: ScoutAgentRoles.Verifier,
        spec: thread.spec,
        get threadSnapshot() {
          return thread;
        },
        runTurn: (turn) => input.runTurn
          ? input.runTurn(turn, runtime)
          : Promise.resolve(completedTurn("")),
        setGoal: async () => undefined,
      },
    });
  return {
    runtime,
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

function itemTimelineEntry(seq: number, itemId: string): AppServerTimelineEntry {
  return {
    seq,
    receivedAt: new Date().toISOString(),
    stream: "item",
    kind: "item_started",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
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

function resolvedProgressEntry(itemId: string, label: string): AppServerResolvedTimelineEntry {
  const entry = itemTimelineEntry(0, itemId);
  return {
    entry,
    progressItem: {
      itemId,
      threadId: "thread-1",
      turnId: "turn-1",
      type: "commandExecution",
      status: "inProgress",
      label,
      item: {
        id: itemId,
        type: "commandExecution",
        command: label,
        status: "inProgress",
      },
      updatedAt: entry.receivedAt,
    },
  };
}

function resolvedItemEntry(itemId: string): AppServerResolvedTimelineEntry {
  const entry = itemTimelineEntry(0, itemId);
  return {
    entry,
    item: {
      id: itemId,
      type: "reasoning",
      status: "inProgress",
      summary: ["Inspecting public evidence."],
      content: ["raw private reasoning"],
    },
  };
}

function resolvedMessageEntry(
  type: "agentMessage" | "userMessage",
  itemId: string,
): AppServerResolvedTimelineEntry {
  const entry = itemTimelineEntry(0, itemId);
  return {
    entry,
    item: type === "agentMessage"
      ? {
          id: itemId,
          type,
          text: "progress placeholder",
        }
      : {
          id: itemId,
          type,
          content: [{ type: "inputText", text: "user prompt" }],
        },
  };
}

function completedTurn(
  finalResponse: string,
  turnId = "turn-1",
  toolCalls: AgentTaskStepToolCall[] = [],
): ScoutAgentTurnOutcome {
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
    toolCalls,
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(await predicate(), true);
}
