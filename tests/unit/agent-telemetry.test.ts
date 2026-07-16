import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentActivity } from "../../src/agent/activity/activity-event.js";
import { AgentRegistry } from "../../src/agent/core/agent-registry.js";
import type { ScoutAgent } from "../../src/agent/core/scout-agent.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import {
  AgentActivityRecorder,
  TaskEventRecorder,
} from "../../src/agent/telemetry/index.js";
import type { AgentTaskNotAssignedEventPayload } from "../../src/agent/task/task-events.js";
import type { AgentTaskState } from "../../src/agent/task/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";

test("TaskEventRecorder writes incremental task events without repeating task history", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-task-recorder-"));
  const logsRoot = join(root, "agents", "researcher", "logs");
  const eventBus = new InMemoryEventBus();
  const registry = registryWithAgent("researcher", logsRoot);
  const recorder = new TaskEventRecorder({
    runId: "run-task-recorder",
    eventBus,
    registry,
  });
  recorder.start();

  const task = taskState();
  await eventBus.publishAndWait(AgentEvents.task.assigned, task);
  await eventBus.publishAndWait(AgentEvents.task.stepStarted, {
    ...task,
    status: "running",
    steps: [
      {
        stepId: "researcher-task-0001-step-0001",
        taskId: task.taskId,
        turnId: "turn-1",
        status: "completed",
        prompt: "Old prompt that must not be repeated",
        finalResponse: "Old response that must not be repeated",
        toolCalls: [],
        startedAt: "2026-07-14T00:00:01.000Z",
        finishedAt: "2026-07-14T00:00:02.000Z",
      },
      {
        stepId: "researcher-task-0001-step-0002",
        taskId: task.taskId,
        status: "running",
        prompt: "Inspect current evidence",
        toolCalls: [],
        startedAt: "2026-07-14T00:00:03.000Z",
      },
    ],
  } satisfies AgentTaskState);
  await eventBus.publishAndWait(AgentEvents.task.stepCompleted, {
    ...task,
    status: "running",
    steps: [
      {
        stepId: "researcher-task-0001-step-0001",
        taskId: task.taskId,
        turnId: "turn-1",
        status: "completed",
        prompt: "Old prompt that must not be repeated",
        finalResponse: "Old response that must not be repeated",
        toolCalls: [],
        startedAt: "2026-07-14T00:00:01.000Z",
        finishedAt: "2026-07-14T00:00:02.000Z",
      },
      {
        stepId: "researcher-task-0001-step-0002",
        taskId: task.taskId,
        turnId: "turn-2",
        status: "completed",
        prompt: "Inspect current evidence",
        finalResponse: "Current response",
        toolCalls: [],
        startedAt: "2026-07-14T00:00:03.000Z",
        finishedAt: "2026-07-14T00:00:04.000Z",
      },
    ],
  } satisfies AgentTaskState);
  await eventBus.publishAndWait(AgentEvents.task.planUpdated, {
    ...task,
    status: "running",
    plan: {
      explanation: "Research current evidence.",
      steps: [{ step: "Locate BDD", status: "inProgress", raw: {} }],
    },
  } satisfies AgentTaskState);
  await eventBus.publishAndWait(AgentEvents.task.notAssigned, {
    agentId: "researcher",
    role: "researcher",
    activeTaskId: task.taskId,
    requestedDescription: "Research another BDD",
    reason: "The current task has not been archived.",
  } satisfies AgentTaskNotAssignedEventPayload);
  recorder.stop();

  const taskLogPath = join(logsRoot, `${task.taskId}.log`);
  const text = readFileSync(taskLogPath, "utf8");
  assert.match(text, /event=agent\.task\.assigned/);
  assert.match(text, /event=agent\.task\.step_started/);
  assert.match(text, /event=agent\.task\.step_completed/);
  assert.match(text, /event=agent\.task\.plan_updated/);
  assert.match(text, /event=agent\.task\.not_assigned/);
  assert.match(text, /initialPrompt: "Research current BDD evidence"/);
  assert.match(text, /prompt: "Inspect current evidence"/);
  assert.match(text, /finalResponse: "Current response"/);
  assert.doesNotMatch(text, /Old prompt that must not be repeated/);
  assert.doesNotMatch(text, /Old response that must not be repeated/);
  assert.equal(text.match(/initialPrompt:/g)?.length, 1);
  assert.match(text, /requestedDescription: "Research another BDD"/);
  assert.equal(existsSync(join(root, "logs", "runtime.log")), false);
  assert.equal(existsSync(join(logsRoot, "activity.log")), false);
});

test("AgentActivityRecorder writes stable activity to the role activity log", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-activity-recorder-"));
  const logsRoot = join(root, "agents", "researcher", "logs");
  const eventBus = new InMemoryEventBus();
  const registry = registryWithAgent("researcher", logsRoot);
  const recorder = new AgentActivityRecorder({
    runId: "run-activity-recorder",
    eventBus,
    registry,
  });
  recorder.start();

  await eventBus.publishAndWait(AgentEvents.activity.observed, activity({
    type: "reasoning",
    status: "inProgress",
    label: "Reasoning",
    detail: "Partial summary",
  }));
  await eventBus.publishAndWait(AgentEvents.activity.observed, activity({
    seq: 2,
    type: "reasoning",
    status: "completed",
    label: "Reasoning",
    detail: "Stable summary",
  }));
  await eventBus.publishAndWait(AgentEvents.activity.observed, activity({
    seq: 3,
    type: "dynamicToolCall",
    status: "completed",
    label: "ArchiveTask",
  }));
  await eventBus.publishAndWait(AgentEvents.activity.observed, activity({
    seq: 4,
    type: "commandExecution",
    status: "completed",
    label: "rg BDD-001",
  }));
  recorder.stop();

  const activityLogPath = join(logsRoot, "activity.log");
  const text = readFileSync(activityLogPath, "utf8");
  assert.equal(readEventCount(text), 2);
  assert.match(text, /detail: "Stable summary"/);
  assert.match(text, /label: "rg BDD-001"/);
  assert.doesNotMatch(text, /Partial summary/);
  assert.doesNotMatch(text, /ArchiveTask/);
  assert.equal(existsSync(join(root, "logs", "runtime.log")), false);
  assert.equal(existsSync(join(logsRoot, "researcher-task-0001.log")), false);
});

function registryWithAgent(agentId: string, logsRoot: string): AgentRegistry {
  const registry = new AgentRegistry();
  registry.registerAgent({
    agentId,
    get mount() {
      return { logsRoot };
    },
  } as ScoutAgent);
  return registry;
}

function taskState(): AgentTaskState {
  return {
    type: "local_agent",
    taskId: "researcher-task-0001",
    taskSequence: 1,
    agentId: "researcher",
    role: "researcher",
    description: "Research current BDD evidence",
    initialPrompt: "Research current BDD evidence",
    status: "queued",
    isBackgrounded: true,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

function activity(input: Partial<AgentActivity>): AgentActivity {
  return {
    seq: 1,
    agentId: "researcher",
    role: "researcher",
    taskId: "researcher-task-0001",
    threadId: "thread-researcher",
    turnId: "turn-1",
    itemId: `item-${input.seq ?? 1}`,
    type: "commandExecution",
    status: "inProgress",
    label: "command",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...input,
  };
}

function readEventCount(text: string): number {
  return text.trim().split(/\n(?=\d{4}-\d{2}-\d{2}T)/).filter(Boolean).length;
}
