import test, { type TestContext } from "node:test";
import {
  createTestRunPersistence,
  installTestRunScope,
} from "../helpers/run-persistence.js";
import assert from "node:assert/strict";
import { AgentTaskBackend } from "../../src/agent/backend/agent-task-backend.js";
import { AgentRegistry } from "../../src/agent/core/agent-registry.js";
import { WorkerRunner } from "../../src/agent/runner/worker/worker-runner.js";
import {
  ScoutAgentRoles,
  ScoutAgentPhases,
  type AgentThreadSpec,
} from "../../src/agent/thread/types.js";
import type {
  AgentTaskStepToolCall,
  AgentTaskState,
  AssignAgentTaskInput,
} from "../../src/agent/task/types.js";
import {
  AgentTaskStatuses,
  AgentTaskStepStatuses,
  AgentTaskDispositionKinds,
} from "../../src/agent/task/types.js";
import {
  agent,
} from "../../src/agent/context/agent-attachments.js";
import {
  EventSubscriptionPriorities,
  InMemoryEventBus,
  type ScoutEvent,
} from "../../src/core/events/index.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import type {
  ScoutAgentTurnInput,
  ScoutAgentTurnOutcome,
  ScoutAgent,
} from "../../src/agent/core/scout-agent.js";
import type { WorkerAgent } from "../../src/agent/roles/worker-agent.js";
import type {
  AppServerPlanState,
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
} from "../../src/agent-server/codex/app-server-event-store.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/protocol/port.js";
import {
  installRunScope,
  RunScope,
} from "../../src/run/run-scope.js";
import { AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE } from "../../src/agent/tools/agent-tools.js";

test("WorkerRunner runs one bounded correction turn and fails visibly when both turns omit disposition", async (t) => {
  let turnCount = 0;
  const harness = await createHarness(t, {
    taskInput: {
      taskId: "task-1",
      description: "Verify behavior",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Verify BDD"),
    },
    runTurn: async () => {
      turnCount += 1;
      return completedTurn(`worker response ${turnCount}`, `turn-${turnCount}`);
    },
  });

  await harness.runtime.runTasksToIdle();
  await harness.runtime.runTasksToIdle();

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(turnCount, 2);
  assert.equal(task?.status, AgentTaskStatuses.Failed);
  assert.equal(Object.hasOwn(task ?? {}, "result"), false);
  assert.equal(task?.steps?.length, 2);
  assert.equal(task?.steps?.[0]?.status, AgentTaskStepStatuses.Completed);
  assert.equal(task?.steps?.[0]?.finalResponse, "worker response 1");
  assert.equal(
    task?.steps?.[0]?.disposition?.kind,
    AgentTaskDispositionKinds.ProtocolViolation,
  );
  assert.equal(task?.steps?.[1]?.status, AgentTaskStepStatuses.Failed);
  assert.equal(
    task?.steps?.[1]?.disposition?.kind,
    AgentTaskDispositionKinds.ProtocolViolation,
  );
  assert.match(task?.steps?.[0]?.prompt ?? "", /当前任务信息：/);
  assert.match(task?.steps?.[0]?.prompt ?? "", /任务 ID：task-1/);
  assert.match(task?.steps?.[0]?.prompt ?? "", /Agent 角色：verifier/);
  assert.match(task?.steps?.[1]?.prompt ?? "", /运行时协议修正/);
  assert.equal(harness.terminalTasks.length, 1);
  assert.equal(harness.protocolFailures.length, 1);
  assert.match(harness.protocolFailures[0] ?? "", /WORKER_DISPOSITION_REQUIRED/);
});

test("WorkerRunner accepts SubmitTask from its single correction turn", async (t) => {
  let turnCount = 0;
  const harness = await createHarness(t, {
    taskInput: {
      taskId: "task-1",
      description: "Repair a missed disposition",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Verify BDD"),
    },
    runTurn: async (turn, runtime) => {
      turnCount += 1;
      if (turnCount === 2) {
        assert.match(turn.prompt, /运行时协议修正/);
        await submit(runtime, "## Outcome\n\nrepaired", "turn-2", "submit-2");
      }
      return completedTurn(`worker response ${turnCount}`, `turn-${turnCount}`);
    },
  });

  await harness.runtime.runTasksToIdle();

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(turnCount, 2);
  assert.equal(task?.status, AgentTaskStatuses.Done);
  assert.equal(task?.steps?.length, 2);
  assert.equal(task?.steps?.[0]?.disposition?.kind, AgentTaskDispositionKinds.ProtocolViolation);
  assert.equal(task?.steps?.[1]?.disposition?.kind, AgentTaskDispositionKinds.HandoffSubmitted);
  assert.deepEqual(harness.deliveredOutcomes, ["## Outcome\n\nrepaired"]);
  assert.deepEqual(harness.protocolFailures, []);
});

test("WorkerRunner starts another turn only after a message is queued", async (t) => {
  const turnPrompts: string[] = [];
  const harness = await createHarness(t, {
    taskInput: {
      taskId: "task-1",
      description: "Observe task",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Initial task prompt"),
    },
    runTurn: async (turn, runtime) => {
      turnPrompts.push(turn.prompt);
      const turnId = `turn-${turnPrompts.length}`;
      const request = `Need human input ${turnPrompts.length}.`;
      await waitForHuman(runtime, request, turnId, `human-${turnPrompts.length}`);
      return completedTurn(`turn-${turnPrompts.length}`, turnId, [
        requestHumanInputToolCall(request, `human-${turnPrompts.length}`),
      ]);
    },
  });

  await harness.runtime.runTasksToIdle();
  await harness.runtime.runTasksToIdle();
  assert.equal(turnPrompts.length, 1);

  await harness.runtime.queueMessage({
    taskId: "task-1",
    message: agent.turn.message("Continue with the new evidence."),
  });
  await harness.runtime.runTasksToIdle();

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(task?.status, AgentTaskStatuses.Running);
  assert.equal(task?.steps?.length, 2);
  assert.match(turnPrompts[0] ?? "", /use-update-tools/);
  assert.match(turnPrompts[0] ?? "", /Initial task prompt/);
  assert.match(turnPrompts[0] ?? "", /任务 ID：task-1/);
  assert.match(turnPrompts[1] ?? "", /use-update-tools/);
  assert.match(turnPrompts[1] ?? "", /Continue with the new evidence\./);
  assert.doesNotMatch(turnPrompts[1] ?? "", /当前任务信息：/);
  assert.ok(harness.events.some((event) =>
    AgentEvents.task.stepCompleted.is(event)
    && (event.payload as AgentTaskState).status === AgentTaskStatuses.Running
  ));
});

test("WorkerRunner accepts a fixed message delivery only once and rejects conflicting retries", async (t) => {
  let turnCount = 0;
  const harness = await createHarness(t, {
    taskInput: {
      taskId: "task-1",
      description: "Observe fixed message delivery",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Initial task prompt"),
    },
    runTurn: async (_turn, runtime) => {
      turnCount += 1;
      const request = `Need human input ${turnCount}.`;
      await waitForHuman(runtime, request, `turn-${turnCount}`, `human-${turnCount}`);
      return completedTurn(`turn-${turnCount}`, `turn-${turnCount}`, [
        requestHumanInputToolCall(request, `human-${turnCount}`),
      ]);
    },
  });
  await harness.runtime.runTasksToIdle();
  const delivery = {
    messageId: "fixed-message-1",
    queuedAt: "2026-07-23T00:00:00.000Z",
  };

  await harness.runtime.queueMessage({
    taskId: "task-1",
    message: agent.turn.message("只处理一次。"),
    delivery,
  });
  await harness.runtime.runTasksToIdle();
  await harness.runtime.queueMessage({
    taskId: "task-1",
    message: agent.turn.message("只处理一次。"),
    delivery,
  });
  await harness.runtime.runTasksToIdle();

  assert.equal(turnCount, 2);
  assert.equal(
    harness.events.filter((event) =>
      AgentEvents.message.queued.is(event)
      && event.payload.messageId === delivery.messageId
    ).length,
    1,
  );
  await assert.rejects(
    harness.runtime.queueMessage({
      taskId: "task-1",
      message: agent.turn.message("冲突正文。"),
      delivery,
    }),
    /does not match its Worker delivery/,
  );
});

test("WorkerRunner records RequestHumanInput without changing task status", async (t) => {
  let turnCount = 0;
  const harness = await createHarness(t, {
    taskInput: {
      taskId: "task-1",
      description: "Inspect explicit lifecycle commands",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Inspect lifecycle"),
    },
    runTurn: async (_turn, runtime) => {
      turnCount += 1;
      await waitForHuman(runtime, "Need human input.", "turn-1", "human-1");
      return completedTurn("waiting", "turn-1", [{
        namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
        tool: "RequestHumanInput",
        callId: "human-1",
        arguments: {
          request: "Need human input.",
        },
        success: true,
      }]);
    },
  });

  await harness.runtime.runTasksToIdle();

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(turnCount, 1);
  assert.equal(task?.status, AgentTaskStatuses.Running);
  assert.deepEqual(task?.steps?.[0]?.humanInputRequest, { body: "Need human input." });
  assert.equal(harness.events.some((event) => AgentEvents.task.done.is(event)), false);
});

test("WorkerRunner enters done from SubmitTask and resumes the same task from a message", async (t) => {
  let turnCount = 0;
  const turnPrompts: string[] = [];
  const harness = await createHarness(t, {
    taskInput: {
      taskId: "task-1",
      description: "Verify behavior",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Verify BDD"),
    },
    runTurn: async (turn, runtime) => {
      turnCount += 1;
      turnPrompts.push(turn.prompt);
      await submit(runtime, `## Outcome ${turnCount}`, `turn-${turnCount}`, `submit-${turnCount}`);
      return completedTurn(`worker response ${turnCount}`, `turn-${turnCount}`);
    },
  });

  await harness.runtime.runTasksToIdle();
  assert.equal(harness.runtime.getTaskSnapshot("task-1")?.status, AgentTaskStatuses.Done);
  assert.equal(harness.terminalTasks.length, 0);
  assert.ok(harness.events.some((event) => AgentEvents.task.done.is(event)));
  assert.deepEqual(harness.deliveredOutcomes, ["## Outcome 1"]);
  assert.deepEqual(harness.submissionOrder.slice(-4), [
    "step_completed",
    "outcome_submitted",
    "task_done",
    "outcome_delivered",
  ]);

  await harness.runtime.queueMessage({
    taskId: "task-1",
    message: agent.turn.message("Please correct the evidence refs."),
  });
  await harness.runtime.runTasksToIdle();

  const resumed = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(resumed?.status, AgentTaskStatuses.Done);
  assert.equal(resumed?.steps?.length, 2);
  assert.match(turnPrompts[1] ?? "", /<message>\nPlease correct the evidence refs\.\n<\/message>/);
});

test("WorkerRunner archive waits for the active turn before deleting task state", async (t) => {
  let releaseTurn: (() => void) | undefined;
  let markTurnStarted: (() => void) | undefined;
  const turnStarted = new Promise<void>((resolve) => {
    markTurnStarted = resolve;
  });
  const turnReleased = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const harness = await createHarness(t, {
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

test("WorkerRunner explicitly initializes and registers its single task", async (t) => {
  const harness = await createHarness(t, {
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
  await harness.runtime.stopAgent();
});

test("WorkerRunner rejects an untagged message without starting another step", async (t) => {
  const harness = await createHarness(t, {
    taskInput: {
      taskId: "task-1",
      description: "Choose option",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Need human input"),
    },
    runTurn: async (_turn, runtime) => {
      await waitForHuman(runtime, "Need human input.", "turn-1", "human-1");
      return completedTurn("waiting", "turn-1", [{
        namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
        tool: "RequestHumanInput",
        callId: "human-1",
        arguments: {
          request: "Need human input.",
        },
        success: true,
      }]);
    },
  });
  await harness.runtime.runTasksToIdle();

  await assert.rejects(harness.runtime.queueMessage({
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

test("WorkerRunner serves an ordinary message after a request step yields", async (t) => {
  let turnCount = 0;
  const turnPrompts: string[] = [];
  const harness = await createHarness(t, {
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
        await waitForHuman(runtime, "Need human input.", "turn-1", "human-1");
        return completedTurn("waiting", "turn-1", [{
          namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
          tool: "RequestHumanInput",
          callId: "human-1",
          arguments: {
            request: "Need human input.",
          },
          success: true,
        }]);
      }
      await submit(runtime, "## Outcome\n\ncontinued", "turn-2", "submit-2");
      return completedTurn("continued", "turn-2");
    },
  });

  await harness.runtime.runTasksToIdle();
  assert.equal(
    harness.runtime.getTaskSnapshot("task-1")?.status,
    AgentTaskStatuses.Running,
  );

  await harness.runtime.queueMessage({
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

test("WorkerRunner records a human-input request on its completed step", async (t) => {
  const harness = await createHarness(t, {
    taskInput: {
      taskId: "task-1",
      description: "Choose option",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Need human input"),
    },
    runTurn: async (_turn, runtime) => {
      await waitForHuman(runtime, "Need human input.", "turn-1", "human-1");
      return completedTurn("waiting", "turn-1", [{
        namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
        tool: "RequestHumanInput",
        callId: "human-1",
        arguments: {
          request: "Need human input.",
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

test("WorkerRunner records a delayed human response on the step that consumes it", async (t) => {
  let turnCount = 0;
  const turnPrompts: string[] = [];
  const harness = await createHarness(t, {
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
        await waitForHuman(
          runtime,
          `Need human input ${turnCount}.`,
          `turn-${turnCount}`,
          `human-${turnCount}`,
        );
        return completedTurn(`request-${turnCount}`, `turn-${turnCount}`, [{
          namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
          tool: "RequestHumanInput",
          callId: `human-${turnCount}`,
          arguments: {
            request: `Need human input ${turnCount}.`,
          },
          success: true,
        }]);
      }
      await submit(runtime, "## Outcome\n\nresumed", `turn-${turnCount}`, `submit-${turnCount}`);
      return completedTurn("resumed", `turn-${turnCount}`);
    },
  });

  await harness.runtime.runTasksToIdle();

  await harness.runtime.queueMessage({
    taskId: "task-1",
    message: agent.turn.message("Please clarify the requested account."),
  });
  await harness.runtime.runTasksToIdle();

  await harness.runtime.queueMessage({
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

test("WorkerRunner rejects a second SubmitTask in the same step", async (t) => {
  const harness = await createHarness(t, {
    taskInput: {
      taskId: "task-1",
      description: "Submit once",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Submit one outcome"),
    },
    runTurn: async (_turn, runtime) => {
      await submit(runtime, "first outcome", "turn-1", "submit-1");
      await assert.rejects(
        submit(runtime, "second outcome", "turn-1", "submit-2"),
        /already recorded lifecycle disposition/,
      );
      return completedTurn("submitted", "turn-1");
    },
  });

  await harness.runtime.runTasksToIdle();

  assert.equal(harness.runtime.getTaskSnapshot("task-1")?.status, AgentTaskStatuses.Done);
  assert.deepEqual(harness.deliveredOutcomes, ["first outcome"]);
});

test("WorkerRunner treats the same SubmitTask call retry as idempotent", async (t) => {
  const harness = await createHarness(t, {
    taskInput: {
      taskId: "task-1",
      description: "Retry one submission",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Submit one outcome"),
    },
    runTurn: async (_turn, runtime) => {
      await submit(runtime, "same outcome", "turn-1", "submit-1");
      await submit(runtime, "same outcome", "turn-1", "submit-1");
      return completedTurn("submitted", "turn-1");
    },
  });

  await harness.runtime.runTasksToIdle();

  assert.equal(harness.runtime.getTaskSnapshot("task-1")?.status, AgentTaskStatuses.Done);
  assert.equal(
    harness.events.filter((event) => AgentEvents.task.dispositionRecorded.is(event)).length,
    1,
  );
  assert.deepEqual(harness.deliveredOutcomes, ["same outcome"]);
});

test("WorkerRunner rejects a lifecycle disposition from another completed turn", async (t) => {
  const harness = await createHarness(t, {
    taskInput: {
      taskId: "task-1",
      description: "Reject a stale submission",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Submit one outcome"),
    },
    runTurn: async (_turn, runtime) => {
      await submit(runtime, "stale outcome", "turn-stale", "submit-stale");
      return completedTurn("completed current turn", "turn-current");
    },
  });

  await harness.runtime.runTasksToIdle();

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(task?.status, AgentTaskStatuses.Failed);
  assert.match(task?.error ?? "", /lifecycle disposition for turn turn-stale, not completed turn turn-current/);
  assert.deepEqual(harness.deliveredOutcomes, []);
  assert.equal(harness.events.some((event) => AgentEvents.task.outcomeSubmitted.is(event)), false);
  assert.equal(harness.events.some((event) => AgentEvents.task.done.is(event)), false);
});

test("WorkerRunner rejects RequestHumanInput after SubmitTask in the same step", async (t) => {
  const harness = await createHarness(t, {
    taskInput: {
      taskId: "task-1",
      description: "Choose one lifecycle action",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Choose one action"),
    },
    runTurn: async (_turn, runtime) => {
      await submit(runtime, "submitted", "turn-1", "submit-1");
      assert.throws(
        () => runtime.beginHumanInput({
          request: "Need input.",
          turnId: "turn-1",
          callId: "human-1",
        }),
        /already recorded lifecycle disposition handoff_submitted/,
      );
      return completedTurn("submitted", "turn-1");
    },
  });

  await harness.runtime.runTasksToIdle();
  assert.equal(harness.runtime.getTaskSnapshot("task-1")?.status, AgentTaskStatuses.Done);
});

test("WorkerRunner rejects SubmitTask after RequestHumanInput in the same step", async (t) => {
  const harness = await createHarness(t, {
    taskInput: {
      taskId: "task-1",
      description: "Choose one lifecycle action",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Choose one action"),
    },
    runTurn: async (_turn, runtime) => {
      await waitForHuman(runtime, "Need input.", "turn-1", "human-1");
      await assert.rejects(
        submit(runtime, "submitted", "turn-1", "submit-1"),
        /already recorded lifecycle disposition waiting_for_human/,
      );
      return completedTurn("waiting", "turn-1", [
        requestHumanInputToolCall("Need input.", "human-1"),
      ]);
    },
  });

  await harness.runtime.runTasksToIdle();
  assert.equal(harness.runtime.getTaskSnapshot("task-1")?.status, AgentTaskStatuses.Running);
});

test("WorkerRunner records an interrupted app-server turn as an interrupted step", async (t) => {
  const harness = await createHarness(t, {
    taskInput: {
      taskId: "task-1",
      description: "Interrupt work",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Interrupt this turn"),
    },
    runTurn: async () => interruptedTurn("turn-1"),
  });

  await harness.runtime.runTasksToIdle();

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(task?.status, AgentTaskStatuses.Running);
  assert.equal(task?.steps?.[0]?.status, AgentTaskStepStatuses.Interrupted);
  assert.equal(task?.steps?.length, 1);
  assert.equal(
    harness.events.filter((event) => AgentEvents.task.stepInterrupted.is(event)).length,
    1,
  );
});

test("WorkerRunner discards a submitted outcome when the turn fails", async (t) => {
  const harness = await createHarness(t, {
    taskInput: {
      taskId: "task-1",
      description: "Fail after submit",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Submit then fail"),
    },
    runTurn: async (_turn, runtime) => {
      await submit(runtime, "must not be delivered", "turn-1", "submit-1");
      return failedTurn("turn failed");
    },
  });

  await harness.runtime.runTasksToIdle();

  assert.equal(harness.runtime.getTaskSnapshot("task-1")?.status, AgentTaskStatuses.Failed);
  assert.deepEqual(harness.deliveredOutcomes, []);
  assert.equal(harness.events.some((event) => AgentEvents.task.done.is(event)), false);
});

test("WorkerRunner keeps done after task outcome delivery fails", async (t) => {
  const harness = await createHarness(t, {
    taskInput: {
      taskId: "task-1",
      description: "Deliver outcome",
      subagentType: ScoutAgentRoles.Verifier,
      prompt: agent.turn.message("Submit an outcome"),
    },
    runTurn: async (_turn, runtime) => {
      await submit(runtime, "undeliverable outcome", "turn-1", "submit-1");
      return completedTurn("submitted", "turn-1");
    },
    deliverTaskOutcome: () => {
      throw new Error("Coordinator queue unavailable");
    },
  });

  await harness.runtime.runTasksToIdle();

  const task = harness.runtime.getTaskSnapshot("task-1");
  assert.equal(task?.status, AgentTaskStatuses.Done);
  assert.equal(task?.steps?.[0]?.status, AgentTaskStepStatuses.Completed);
  assert.deepEqual(harness.deliveredOutcomes, []);
  assert.equal(harness.events.some((event) => AgentEvents.task.done.is(event)), true);
});

test("AgentTaskBackend reduces app-server plan timeline entries into task state", (t) => {
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
    ...createTestRunPersistence(t, runId),
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
  const completedFirstPlan = planState("turn-1", "first completed", "completed");
  const secondPlan = planState("turn-2", "second", "completed");

  backend.handleAppServerTimelineEntry(
    agent,
    planTimelineEntry(1, "turn-1"),
    () => resolvedPlanEntry(firstPlan),
  );
  backend.handleAppServerTimelineEntry(
    agent,
    planTimelineEntry(2, "turn-1"),
    () => resolvedPlanEntry(completedFirstPlan),
  );
  backend.handleAppServerTimelineEntry(
    agent,
    planTimelineEntry(3, "turn-2"),
    () => resolvedPlanEntry(secondPlan),
  );
  const task = store.getTask("task-1");
  assert.equal(task?.plan?.turnId, "turn-2");
  assert.equal(task?.plan?.explanation, "second");
  assert.deepEqual(task?.planRecords?.map((plan) => plan.turnId), ["turn-1", "turn-2"]);
  assert.deepEqual(task?.planRecords?.map((plan) => plan.explanation), ["first completed", "second"]);
  assert.deepEqual(task?.planRecords?.map((plan) => plan.steps[0]?.status), ["completed", "completed"]);
});

async function createHarness(t: TestContext, input: {
  taskInput?: AssignAgentTaskInput;
  runTurn?: (turn: ScoutAgentTurnInput, runtime: WorkerRunner) => Promise<ScoutAgentTurnOutcome>;
  deliverTaskOutcome?: (outcome: string, runtime: WorkerRunner) => void | Promise<void>;
} = {}): Promise<{
  runtime: WorkerRunner;
  events: ScoutEvent[];
  terminalTasks: AgentTaskState[];
  deliveredOutcomes: string[];
  protocolFailures: string[];
  submissionOrder: string[];
}> {
  const eventBus = new InMemoryEventBus();
  installTestRunScope(t, {
    runId: "worker-runner-harness",
    eventBus,
  });
  const events: ScoutEvent[] = [];
  const terminalTasks: AgentTaskState[] = [];
  const deliveredOutcomes: string[] = [];
  const protocolFailures: string[] = [];
  const submissionOrder: string[] = [];
  for (const key of [
    AgentEvents.message.queued,
    AgentEvents.message.consumed,
    AgentEvents.task.assigned,
    AgentEvents.task.messageQueued,
    AgentEvents.task.done,
    AgentEvents.task.archived,
    AgentEvents.task.pendingMessagesDrained,
    AgentEvents.task.stepStarted,
    AgentEvents.task.stepCompleted,
    AgentEvents.task.stepInterrupted,
    AgentEvents.task.dispositionRecorded,
    AgentEvents.task.outcomeSubmitted,
    AgentEvents.task.failed,
    AgentEvents.task.terminal,
  ]) {
    eventBus.subscribe(
      key,
      (event) => {
        events.push(event);
        if (AgentEvents.task.stepCompleted.is(event)) submissionOrder.push("step_completed");
        if (AgentEvents.task.outcomeSubmitted.is(event)) submissionOrder.push("outcome_submitted");
        if (AgentEvents.task.done.is(event)) submissionOrder.push("task_done");
        if (AgentEvents.task.terminal.is(event)) {
          terminalTasks.push(event.payload as AgentTaskState);
        }
      },
      { priority: EventSubscriptionPriorities.High },
    );
  }
  const spec: AgentThreadSpec = {
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
  };
  let runtime: WorkerRunner;
  runtime = new WorkerRunner({
      taskSequence: 1,
      host: {
        agentId: "verifier",
        role: ScoutAgentRoles.Verifier,
        spec,
        runTurn: (turn) => input.runTurn
          ? input.runTurn(turn, runtime)
          : Promise.resolve(completedTurn("")),
        deliverTaskOutcome: async (outcome) => {
          await input.deliverTaskOutcome?.(outcome, runtime);
          deliveredOutcomes.push(outcome);
          submissionOrder.push("outcome_delivered");
        },
        deliverTaskProtocolFailure: async (message) => {
          protocolFailures.push(message);
          submissionOrder.push("protocol_failure_delivered");
        },
      },
    });
  if (input.taskInput) {
    await runtime.assignTask(input.taskInput);
  }
  return {
    runtime,
    events,
    terminalTasks,
    deliveredOutcomes,
    protocolFailures,
    submissionOrder,
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

async function submit(
  runtime: WorkerRunner,
  outcome: string,
  turnId: string,
  callId: string,
): Promise<AgentTaskState> {
  return runtime.submitTask({ outcome, turnId, callId });
}

async function waitForHuman(
  runtime: WorkerRunner,
  request: string,
  turnId: string,
  callId: string,
): Promise<AgentTaskState> {
  runtime.beginHumanInput({ request, turnId, callId });
  return runtime.completeHumanInput({
    request,
    requestId: `${callId}-request`,
    turnId,
    callId,
  });
}

function requestHumanInputToolCall(
  request: string,
  callId: string,
): AgentTaskStepToolCall {
  return {
    namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
    tool: "RequestHumanInput",
    callId,
    arguments: { request },
    success: true,
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

function failedTurn(error: string): ScoutAgentTurnOutcome {
  return {
    turn: {
      invocationId: "invocation-1",
      agentId: "verifier",
      role: ScoutAgentRoles.Verifier,
      threadId: "thread-1",
      turnId: "turn-1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "failed",
      error,
    },
  };
}

function interruptedTurn(turnId: string): ScoutAgentTurnOutcome {
  return {
    turn: {
      invocationId: "invocation-interrupted",
      agentId: "verifier",
      role: ScoutAgentRoles.Verifier,
      threadId: "thread-1",
      turnId,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "interrupted",
      error: "interrupted by runtime shutdown",
    },
  };
}
