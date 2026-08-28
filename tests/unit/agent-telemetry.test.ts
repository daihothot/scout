import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentActivity,
  AgentNativeSubagentActivity,
  AgentTurnActivity,
} from "../../src/agent/activity/activity-event.js";
import { attachments } from "../../src/agent/context/attachments.js";
import { AgentRegistry } from "../../src/agent/core/agent-registry.js";
import type { ScoutAgent } from "../../src/agent/core/scout-agent.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import {
  AgentActivityRecorder,
  AgentToolCallRecorder,
  AgentThreadRecorder,
  StepEventRecorder,
  TaskEventRecorder,
} from "../../src/agent/telemetry/index.js";
import type { AgentStepState } from "../../src/agent/step/types.js";
import type { AgentThreadSnapshot } from "../../src/agent/thread/types.js";
import type { AgentToolCallState } from "../../src/agent/tool-call/types.js";
import type { AgentTaskNotAssignedEventPayload } from "../../src/agent/task/task-events.js";
import type { AgentTaskState } from "../../src/agent/task/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("TaskEventRecorder writes only task lifecycle facts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-task-recorder-"));
  const logsRoot = join(root, "agents", "researcher", "logs");
  const eventBus = new InMemoryEventBus();
  const registry = installTestRunScope(t, {
    runId: "run-task-recorder",
    eventBus,
  }).agentRegistry;
  registerAgent(registry, "researcher", logsRoot);
  const recorder = new TaskEventRecorder();
  recorder.start();

  const task = taskState();
  await eventBus.publishAndWait(AgentEvents.task.assigned, task);
  await eventBus.publishAndWait(AgentEvents.task.stepStarted, {
    ...task,
    status: "running",
    stepIds: ["researcher-task-0001-step-0001"],
    updatedAt: "2026-07-14T00:00:01.000Z",
  } satisfies AgentTaskState);
  await eventBus.publishAndWait(AgentEvents.step.started, {
    stepId: "researcher-task-0001-step-0001",
    agentId: "researcher",
    taskId: task.taskId,
    status: "running",
    prompt: "Step prompt must not enter the task log",
    toolCallIds: [],
    humanInputReferences: [],
    startedAt: "2026-07-14T00:00:01.000Z",
    updatedAt: "2026-07-14T00:00:01.000Z",
  } satisfies AgentStepState);
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
  assert.match(text, /event=agent\.task\.not_assigned/);
  assert.match(text, /initialPrompt: "Research current BDD evidence"/);
  assert.doesNotMatch(text, /agent\.task\.step_started/);
  assert.doesNotMatch(text, /agent\.step\.started/);
  assert.doesNotMatch(text, /Step prompt must not enter the task log/);
  assert.equal(text.match(/initialPrompt:/g)?.length, 1);
  assert.match(text, /requestedDescription: "Research another BDD"/);
  assert.equal(existsSync(join(logsRoot, "steps.log")), false);
  assert.equal(existsSync(join(root, "logs", "runtime.log")), false);
  assert.equal(existsSync(join(logsRoot, "activity.log")), false);
});

test("StepEventRecorder writes Worker and Coordinator step facts only to step logs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-step-recorder-"));
  const researcherLogsRoot = join(root, "agents", "researcher", "logs");
  const coordinatorLogsRoot = join(root, "agents", "coordinator", "logs");
  const eventBus = new InMemoryEventBus();
  const registry = installTestRunScope(t, {
    runId: "run-step-recorder",
    eventBus,
  }).agentRegistry;
  registerAgent(registry, "researcher", researcherLogsRoot);
  registerAgent(registry, "coordinator", coordinatorLogsRoot);
  const recorder = new StepEventRecorder();
  recorder.start();

  const startedStep = {
    stepId: "researcher-task-0001-step-0001",
    agentId: "researcher",
    taskId: "researcher-task-0001",
    status: "running",
    prompt: "Inspect current evidence",
    toolCallIds: [],
    humanInputReferences: [],
    startedAt: "2026-07-14T00:00:01.000Z",
    updatedAt: "2026-07-14T00:00:01.000Z",
  } satisfies AgentStepState;
  await eventBus.publishAndWait(AgentEvents.step.started, startedStep);
  await eventBus.publishAndWait(AgentEvents.step.planUpdated, {
    stepId: startedStep.stepId,
    agentId: startedStep.agentId,
    taskId: startedStep.taskId,
    turnId: "turn-1",
    plan: {
      turnId: "turn-1",
      explanation: "Research current evidence.",
      steps: [{ step: "Locate BDD", status: "inProgress", raw: {} }],
    },
    updatedAt: "2026-07-14T00:00:02.000Z",
  });
  await eventBus.publishAndWait(AgentEvents.step.toolCallReferenced, {
    ...startedStep,
    turnId: "turn-1",
    toolCallIds: ["call-submit"],
    updatedAt: "2026-07-14T00:00:02.500Z",
  } satisfies AgentStepState);
  await eventBus.publishAndWait(AgentEvents.step.humanInputReferenced, {
    ...startedStep,
    turnId: "turn-1",
    humanInputReferences: [{
      requestId: "request-1",
      kind: "request_produced",
    }],
    updatedAt: "2026-07-14T00:00:02.750Z",
  } satisfies AgentStepState);
  await eventBus.publishAndWait(AgentEvents.step.completed, {
    ...startedStep,
    turnId: "turn-1",
    status: "completed",
    finalResponse: "Current response",
    toolCallIds: ["call-submit"],
    finishedAt: "2026-07-14T00:00:03.000Z",
    updatedAt: "2026-07-14T00:00:03.000Z",
    durationMs: 2000,
  } satisfies AgentStepState);
  const resumePrompt = attachments.compose(
    "<use-update-tools>\n继续恢复。\n</use-update-tools>",
    attachments.addTagBlock("resume", JSON.stringify({
      task: {
        initial_prompt: "do-not-log-initial-prompt",
        current_step: { id: "step-resume" },
      },
      open: [
        {
          type: "interrupted_task_step",
          step_id: "step-resume",
          prompt: "keep-task-step-prompt",
        },
        {
          type: "interrupted_turn",
          invocation_id: "invocation-resume",
          prompt: "do-not-log-interrupted-turn-prompt",
        },
      ],
    }, null, 2)),
  );
  await eventBus.publishAndWait(AgentEvents.step.started, {
    ...startedStep,
    stepId: "researcher-task-0001-step-0002",
    prompt: resumePrompt,
    startedAt: "2026-07-14T00:00:04.000Z",
    updatedAt: "2026-07-14T00:00:04.000Z",
  } satisfies AgentStepState);
  await eventBus.publishAndWait(AgentEvents.step.started, {
    stepId: "coordinator-step-0001",
    agentId: "coordinator",
    status: "running",
    prompt: "Coordinate the run",
    toolCallIds: [],
    humanInputReferences: [],
    startedAt: "2026-07-14T00:00:04.000Z",
    updatedAt: "2026-07-14T00:00:04.000Z",
  } satisfies AgentStepState);
  recorder.stop();

  const researcherText = readFileSync(join(researcherLogsRoot, "steps.log"), "utf8");
  assert.match(researcherText, /event=agent\.step\.started/);
  assert.match(researcherText, /event=agent\.step\.plan_updated/);
  assert.match(researcherText, /event=agent\.step\.completed/);
  assert.match(researcherText, /prompt: "Inspect current evidence"/);
  assert.match(researcherText, /finalResponse: "Current response"/);
  assert.match(researcherText, /toolCallId: "call-submit"/);
  assert.match(researcherText, /requestId: "request-1"/);
  assert.match(researcherText, /kind: "request_produced"/);
  assert.match(researcherText, /"type": "interrupted_task_step"/);
  assert.match(researcherText, /keep-task-step-prompt/);
  assert.match(researcherText, /"type": "interrupted_turn"/);
  assert.doesNotMatch(researcherText, /initial_prompt|do-not-log-initial-prompt/);
  assert.doesNotMatch(researcherText, /do-not-log-interrupted-turn-prompt/);
  const completedRecord = researcherText.split("\n\n").find((record) =>
    record.includes("event=agent.step.completed")
  );
  assert.ok(completedRecord);
  assert.doesNotMatch(completedRecord, /prompt:|toolCallIds:|plan:|humanInputReferences:/);
  assert.match(researcherText, /explanation: "Research current evidence\."/);
  const planRecord = researcherText.split("\n\n").find((record) =>
    record.includes("event=agent.step.plan_updated")
  );
  assert.ok(planRecord);
  assert.doesNotMatch(planRecord, /prompt:|finalResponse:|toolCallIds:|humanInputReferences:/);
  assert.equal(existsSync(join(researcherLogsRoot, "researcher-task-0001.log")), false);

  const coordinatorText = readFileSync(join(coordinatorLogsRoot, "steps.log"), "utf8");
  assert.match(coordinatorText, /agent=coordinator/);
  assert.match(coordinatorText, /prompt: "Coordinate the run"/);
  assert.doesNotMatch(coordinatorText, / task=/);
});

test("AgentToolCallRecorder aggregates one logical Tool Call lifecycle", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-tool-call-recorder-"));
  const logsRoot = join(root, "agents", "coordinator", "logs");
  const eventBus = new InMemoryEventBus();
  const registry = installTestRunScope(t, {
    runId: "run-tool-call-recorder",
    eventBus,
  }).agentRegistry;
  registerAgent(registry, "coordinator", logsRoot);
  const recorder = new AgentToolCallRecorder();
  recorder.start();

  const started = {
    toolCallId: "call-assign-task",
    kind: "dynamic",
    agentId: "coordinator",
    taskId: undefined,
    stepId: "coordinator-step-0001",
    threadId: "coordinator-thread",
    turnId: "coordinator-turn",
    itemId: "call-assign-task",
    namespace: "scout_agent_assigntask",
    tool: "AssignTask",
    arguments: { subagent_type: "researcher" },
    status: "inProgress",
    success: null,
    contentItems: null,
    sourceSeq: 10,
    observedAt: "2026-07-14T00:00:01.000Z",
  } satisfies AgentToolCallState;
  const failed = {
    ...started,
    status: "failed",
    success: false,
    error: "AssignTask agent_id must be a non-empty string when provided.",
    sourceSeq: 11,
    observedAt: "2026-07-14T00:00:01.005Z",
    finishedAt: "2026-07-14T00:00:01.005Z",
  } satisfies AgentToolCallState;

  await eventBus.publishAndWait(AgentEvents.toolCall.observed, started);
  await eventBus.publishAndWait(AgentEvents.toolCall.observed, failed);
  recorder.stop();

  const text = readFileSync(join(logsRoot, "tool-calls.log"), "utf8");
  assert.equal(readEventCount(text), 1);
  assert.match(text, /event=agent\.tool_call\.summary/);
  assert.match(text, /toolCallId: "call-assign-task"/);
  assert.match(text, /status: "failed"/);
  assert.match(text, /observationCount: 2/);
  assert.match(text, /firstObservedAt: "2026-07-14T00:00:01\.000Z"/);
  assert.match(text, /lastObservedAt: "2026-07-14T00:00:01\.005Z"/);
  assert.match(text, /- "inProgress"/);
  assert.match(text, /- "failed"/);
  assert.match(text, /AssignTask agent_id must be a non-empty string/);
});

test("AgentActivityRecorder writes stable activity to the role activity log", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-activity-recorder-"));
  const logsRoot = join(root, "agents", "researcher", "logs");
  const eventBus = new InMemoryEventBus();
  const registry = installTestRunScope(t, {
    runId: "run-activity-recorder",
    eventBus,
  }).agentRegistry;
  registerAgent(registry, "researcher", logsRoot);
  const recorder = new AgentActivityRecorder();
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
  await eventBus.publishAndWait(AgentEvents.activity.turnObserved, turnActivity({
    seq: 5,
    status: "inProgress",
  }));
  await eventBus.publishAndWait(AgentEvents.activity.turnObserved, turnActivity({
    seq: 6,
    status: "completed",
  }));
  recorder.stop();

  const activityLogPath = join(logsRoot, "activity.log");
  const text = readFileSync(activityLogPath, "utf8");
  assert.equal(readEventCount(text), 4);
  assert.match(text, /detail: "Stable summary"/);
  assert.match(text, /label: "rg BDD-001"/);
  assert.doesNotMatch(text, /Partial summary/);
  assert.doesNotMatch(text, /ArchiveTask/);
  assert.match(text, /event=agent\.activity\.turn_observed/);
  assert.match(text, /status: "inProgress"/);
  assert.equal(existsSync(join(root, "logs", "runtime.log")), false);
  assert.equal(existsSync(join(logsRoot, "researcher-task-0001.log")), false);
});

test("AgentActivityRecorder writes complete native subagent facts to a dedicated log", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-subagent-recorder-"));
  const logsRoot = join(root, "agents", "researcher", "logs");
  const eventBus = new InMemoryEventBus();
  const registry = installTestRunScope(t, {
    runId: "run-subagent-recorder",
    eventBus,
  }).agentRegistry;
  registerAgent(registry, "researcher", logsRoot);
  const recorder = new AgentActivityRecorder();
  recorder.start();

  await eventBus.publishAndWait(AgentEvents.activity.observed, activity({
    type: "collabAgentToolCall",
    status: "completed",
    label: "Native subagent spawnAgent",
    detail: "thread-child-1",
  }));
  await eventBus.publishAndWait(AgentEvents.activity.nativeSubagentObserved, {
    seq: 2,
    agentId: "researcher",
    role: "researcher",
    taskId: "researcher-task-0001",
    threadId: "thread-researcher",
    turnId: "turn-1",
    itemId: "collab-1",
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: "thread-researcher",
    receiverThreadIds: ["thread-child-1"],
    prompt: "检查一个边界明确的只读子任务。",
    model: "gpt-5.5",
    reasoningEffort: "high",
    agentsStates: {
      "thread-child-1": {
        status: "running",
        message: null,
      },
    },
    updatedAt: "2026-07-21T00:00:00.000Z",
  } satisfies AgentNativeSubagentActivity);
  await eventBus.publishAndWait(AgentEvents.activity.nativeSubagentObserved, {
    seq: 3,
    agentId: "researcher",
    role: "researcher",
    taskId: "researcher-task-0001",
    threadId: "thread-researcher",
    turnId: "turn-1",
    itemId: "subagent-activity-1",
    type: "subAgentActivity",
    kind: "started",
    agentThreadId: "thread-child-1",
    agentPath: "019f-child-1",
    updatedAt: "2026-07-21T00:00:01.000Z",
  } satisfies AgentNativeSubagentActivity);
  recorder.stop();

  const subagentLogPath = join(logsRoot, "subagent.log");
  const text = readFileSync(subagentLogPath, "utf8");
  assert.equal(readEventCount(text), 2);
  assert.match(text, /event=agent\.activity\.native_subagent_observed/);
  assert.match(text, /tool: "spawnAgent"/);
  assert.match(text, /receiverThreadIds:/);
  assert.match(text, /thread-child-1/);
  assert.match(text, /prompt: "检查一个边界明确的只读子任务。"/);
  assert.match(text, /kind: "started"/);
  assert.match(text, /agentPath: "019f-child-1"/);
  assert.equal(existsSync(join(logsRoot, "activity.log")), false);
  assert.equal(existsSync(join(root, "logs", "runtime.log")), false);
});

test("AgentThreadRecorder summarizes thread instruction and tool bodies", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-thread-recorder-"));
  const logsRoot = join(root, "agents", "researcher", "logs");
  const eventBus = new InMemoryEventBus();
  const registry = installTestRunScope(t, {
    runId: "run-thread-recorder",
    eventBus,
  }).agentRegistry;
  registerAgent(registry, "researcher", logsRoot);
  const recorder = new AgentThreadRecorder();
  const baseInstructions = `${"base-instruction ".repeat(300)}END_OF_BASE_INSTRUCTIONS`;
  const developerInstructions = `${"complete-instruction ".repeat(300)}END_OF_FULL_INSTRUCTIONS`;
  const resumedBaseInstructions = `${"resume-base-instruction ".repeat(300)}END_OF_RESUME_BASE_INSTRUCTIONS`;
  const resumedDeveloperInstructions = `${"resume-instruction ".repeat(300)}END_OF_RESUME_INSTRUCTIONS`;
  const started: AgentThreadSnapshot = {
    agentId: "researcher",
    role: "researcher",
    phases: ["research"],
    contextBundleId: "cb-thread-recorder",
    threadId: "thread-researcher",
    createdAt: "2026-07-17T00:00:00.000Z",
    status: "active",
    startInput: {
      cwd: "/source-device/run/run-thread-recorder/agents/researcher/mount",
      model: "gpt-5.5",
      modelProvider: "GuruOpenAI",
      approvalPolicy: "never",
      permissions: "scout-researcher",
      ephemeral: true,
      baseInstructions,
      developerInstructions,
      dynamicTools: [{
        namespace: "agent.submit-task",
        name: "SubmitTask",
        description: "FULL_TOOL_DESCRIPTION_MUST_NOT_BE_RECORDED",
        inputSchema: {
          type: "object",
          properties: {
            FULL_TOOL_SCHEMA_MUST_NOT_BE_RECORDED: { type: "string" },
          },
          required: ["FULL_TOOL_SCHEMA_MUST_NOT_BE_RECORDED"],
        },
      }],
    },
    startResponse: {
      thread: {
        id: "thread-researcher",
        preview: "START_RESPONSE_PREVIEW_MUST_NOT_BE_RECORDED",
        turns: [{ body: "START_RESPONSE_TURN_MUST_NOT_BE_RECORDED" }],
      },
      cwd: "/source-device/run/run-thread-recorder/agents/researcher/mount",
      activePermissionProfile: {
        id: "scout-researcher",
      },
    },
  };
  const startedBeforeRecording = structuredClone(started);
  const resumed = {
    agentId: started.agentId,
    role: started.role,
    threadId: started.threadId,
    resumedAt: "2026-07-17T00:30:00.000Z",
    resumeInput: {
      threadId: started.threadId,
      excludeTurns: true as const,
      permissions: "scout-researcher",
      baseInstructions: resumedBaseInstructions,
      developerInstructions: resumedDeveloperInstructions,
    },
    resumeResponse: {
      thread: {
        id: started.threadId,
        path: "/run/codex-home/.codex/sessions/rollout.jsonl",
        cwd: "/source-device/run/run-thread-recorder/agents/researcher/mount",
        preview: "RESUME_RESPONSE_PREVIEW_MUST_NOT_BE_RECORDED",
        turns: [{ body: "RESUME_RESPONSE_TURN_MUST_NOT_BE_RECORDED" }],
      },
      cwd: "/source-device/run/run-thread-recorder/agents/researcher/mount",
      runtimeWorkspaceRoots: [
        "/source-device/run/run-thread-recorder/agents/researcher/mount",
      ],
      instructionSources: [
        "/source-device/run/run-thread-recorder/agents/researcher/mount/AGENTS.md",
      ],
      model: "gpt-5.5",
      modelProvider: "GuruOpenAI",
      approvalPolicy: "never",
      activePermissionProfile: {
        id: "scout-researcher",
      },
    },
  };
  const resumedBeforeRecording = structuredClone(resumed);
  const restartedThread = {
    ...started,
    threadId: "thread-researcher-restarted",
    createdAt: "2026-07-17T00:45:00.000Z",
    startResponse: {
      ...resumed.resumeResponse,
      thread: {
        ...resumed.resumeResponse.thread,
        id: "thread-researcher-restarted",
      },
    },
  } satisfies AgentThreadSnapshot;
  const restarted = {
    previousThreadId: started.threadId,
    reason: "codex_rollout_not_persisted",
    restartedAt: restartedThread.createdAt,
    newThread: restartedThread,
  };
  const restartedBeforeRecording = structuredClone(restarted);
  recorder.start();

  await eventBus.publishAndWait(AgentEvents.thread.started, started);
  await eventBus.publishAndWait(AgentEvents.thread.resumed, resumed);
  await eventBus.publishAndWait(AgentEvents.thread.restarted, restarted);
  await eventBus.publishAndWait(AgentEvents.thread.closed, {
    ...restartedThread,
    status: "closed",
    closedAt: "2026-07-17T01:00:00.000Z",
    closeReason: "run_exit",
  });
  recorder.stop();

  assert.deepEqual(started, startedBeforeRecording);
  assert.deepEqual(resumed, resumedBeforeRecording);
  assert.deepEqual(restarted, restartedBeforeRecording);

  const threadLogPath = join(logsRoot, "thread.log");
  const text = readFileSync(threadLogPath, "utf8");
  assert.equal(readEventCount(text), 4);
  assert.match(text, /event=agent\.thread\.started/);
  assert.match(text, /event=agent\.thread\.resumed/);
  assert.match(text, /event=agent\.thread\.restarted/);
  assert.match(text, /event=agent\.thread\.closed/);
  const eventBlocks = text.trim().split("\n\n");
  const startedBlock = eventBlocks.find((block) =>
    block.includes("event=agent.thread.started")
  );
  const resumedBlock = eventBlocks.find((block) =>
    block.includes("event=agent.thread.resumed")
  );
  const restartedBlock = eventBlocks.find((block) =>
    block.includes("event=agent.thread.restarted")
  );
  assert.ok(startedBlock);
  assert.ok(resumedBlock);
  assert.ok(restartedBlock);
  assert.match(startedBlock, /\ndata:/);
  assert.doesNotMatch(startedBlock, /\nmessage:/);
  assert.match(
    resumedBlock,
    /\nmessage: Resumed Codex thread thread-researcher\./,
  );
  assert.doesNotMatch(resumedBlock, /\ndata:/);
  assert.doesNotMatch(resumedBlock, /resumeInput|resumeResponse|resumedAt/);
  assert.match(restartedBlock, /\ndata:/);
  assert.doesNotMatch(restartedBlock, /\nmessage:/);
  assert.match(restartedBlock, /previousThreadId: "thread-researcher"/);
  assert.match(restartedBlock, /reason: "codex_rollout_not_persisted"/);
  assert.match(restartedBlock, /newThread:/);
  assert.doesNotMatch(restartedBlock, /restartedAt/);
  assert.match(restartedBlock, /thread-researcher-restarted/);
  assert.match(text, /- "AGENTS\.md"/);
  assert.match(text, /- "agents\/worker\.AGENTS\.md"/);
  assert.doesNotMatch(text, /researcher\.AGENTS\.md/);
  assert.match(text, /namespace: "agent\.submit-task"/);
  assert.match(text, /name: "SubmitTask"/);
  assert.match(text, /path: "sessions\/rollout\.jsonl"/);
  assert.match(text, /cwd: "\$\{SCOUT_MOUNT_ROOT\}"/);
  assert.match(text, /- "\$\{SCOUT_MOUNT_ROOT\}"/);
  assert.match(text, /- "\$\{SCOUT_MOUNT_ROOT\}\/AGENTS\.md"/);
  assert.doesNotMatch(text, /source-device/);
  assert.doesNotMatch(text, /\/run\/run-thread-recorder/);
  assert.match(text, /runtimeWorkspaceRoots:/);
  assert.match(text, /activePermissionProfile:/);
  assert.match(text, /id: "scout-researcher"/);
  assert.match(text, /closeReason: "run_exit"/);
  assert.equal(text.match(/developerInstructions:/g)?.length, 2);
  assert.equal(text.match(/hasBaseInstructions: true/g)?.length, 2);
  assert.doesNotMatch(text, /hasInlineDeveloperInstructions/);
  assert.doesNotMatch(text, /END_OF_BASE_INSTRUCTIONS/);
  assert.doesNotMatch(text, /END_OF_RESUME_BASE_INSTRUCTIONS/);
  assert.doesNotMatch(text, /END_OF_FULL_INSTRUCTIONS/);
  assert.doesNotMatch(text, /END_OF_RESUME_INSTRUCTIONS/);
  assert.doesNotMatch(text, /FULL_TOOL_DESCRIPTION_MUST_NOT_BE_RECORDED/);
  assert.doesNotMatch(text, /FULL_TOOL_SCHEMA_MUST_NOT_BE_RECORDED/);
  assert.doesNotMatch(text, /START_RESPONSE_PREVIEW_MUST_NOT_BE_RECORDED/);
  assert.doesNotMatch(text, /START_RESPONSE_TURN_MUST_NOT_BE_RECORDED/);
  assert.doesNotMatch(text, /RESUME_RESPONSE_PREVIEW_MUST_NOT_BE_RECORDED/);
  assert.doesNotMatch(text, /RESUME_RESPONSE_TURN_MUST_NOT_BE_RECORDED/);
  assert.doesNotMatch(text, /threadPreflight/);
});

test("AgentThreadRecorder marks coordinator inline instructions separately from assets", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-coordinator-thread-recorder-"));
  const logsRoot = join(root, "agents", "coordinator", "logs");
  const eventBus = new InMemoryEventBus();
  const registry = installTestRunScope(t, {
    runId: "run-coordinator-thread-recorder",
    eventBus,
  }).agentRegistry;
  registerAgent(registry, "coordinator", logsRoot);
  const recorder = new AgentThreadRecorder();
  const started: AgentThreadSnapshot = {
    agentId: "coordinator",
    role: "coordinator",
    phases: ["Synthesis"],
    contextBundleId: "cb-coordinator-thread-recorder",
    threadId: "thread-coordinator",
    createdAt: "2026-07-17T00:00:00.000Z",
    status: "active",
    startInput: {
      cwd: "/run/agents/coordinator/mount",
      approvalPolicy: "never",
      permissions: "scout-coordinator",
      ephemeral: false,
      developerInstructions: "COORDINATOR_INLINE_BODY_MUST_NOT_BE_RECORDED",
    },
    startResponse: { thread: { id: "thread-coordinator" } },
  };
  recorder.start();

  await eventBus.publishAndWait(AgentEvents.thread.started, started);
  recorder.stop();

  const text = readFileSync(join(logsRoot, "thread.log"), "utf8");
  assert.match(text, /- "AGENTS\.md"/);
  assert.doesNotMatch(text, /coordinator\.AGENTS\.md/);
  assert.match(text, /hasInlineDeveloperInstructions: true/);
  assert.doesNotMatch(text, /worker\.AGENTS\.md/);
  assert.doesNotMatch(text, /COORDINATOR_INLINE_BODY_MUST_NOT_BE_RECORDED/);
});

function registerAgent(
  registry: AgentRegistry,
  agentId: string,
  logsRoot: string,
): void {
  registry.registerAgent({
    agentId,
    get mount() {
      return { logsRoot };
    },
  } as ScoutAgent);
}

function taskState(): AgentTaskState {
  return {
    type: "local_agent",
    taskId: "researcher-task-0001",
    taskSequence: 1,
    agentId: "researcher",
    role: "researcher",
    phase: "research",
    description: "Research current BDD evidence",
    initialPrompt: "Research current BDD evidence",
    status: "queued",
    isBackgrounded: true,
    stepIds: [],
    dispositions: [],
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

function turnActivity(input: Partial<AgentTurnActivity>): AgentTurnActivity {
  return {
    seq: 1,
    agentId: "researcher",
    role: "researcher",
    taskId: "researcher-task-0001",
    threadId: "thread-researcher",
    turnId: "turn-1",
    status: "inProgress",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...input,
  };
}

function readEventCount(text: string): number {
  return text.trim().split(/\n(?=\d{4}-\d{2}-\d{2}T)/).filter(Boolean).length;
}
