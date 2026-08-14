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
import { AgentRegistry } from "../../src/agent/core/agent-registry.js";
import type { ScoutAgent } from "../../src/agent/core/scout-agent.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import {
  AgentActivityRecorder,
  AgentSkillRecorder,
  AgentThreadRecorder,
  TaskEventRecorder,
} from "../../src/agent/telemetry/index.js";
import type {
  AgentSkillFindCompletedEvent,
  AgentSkillReadCompletedEvent,
  AgentSkillReadFailedEvent,
} from "../../src/agent/skill/skill-events.js";
import type { AgentThreadSnapshot } from "../../src/agent/thread/types.js";
import type { AgentTaskNotAssignedEventPayload } from "../../src/agent/task/task-events.js";
import type { AgentTaskState } from "../../src/agent/task/types.js";
import {
  AGENT_FIND_SKILLS_TOOL_NAMESPACE,
  AGENT_READ_SKILL_RESOURCE_TOOL_NAMESPACE,
  AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
} from "../../src/agent/tools/agent-tools.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("TaskEventRecorder writes incremental task events without repeating task history", async (t) => {
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
        toolCalls: [
          {
            namespace: AGENT_FIND_SKILLS_TOOL_NAMESPACE,
            tool: "FindSkills",
            callId: "call-find",
            arguments: {},
            success: true,
          },
          {
            namespace: AGENT_READ_SKILL_RESOURCE_TOOL_NAMESPACE,
            tool: "ReadSkillResource",
            callId: "call-read",
            arguments: { resource: "SKILL.md" },
            success: true,
          },
          {
            namespace: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
            tool: "SubmitTask",
            callId: "call-submit",
            arguments: { outcome: "Current response" },
            success: true,
          },
        ],
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
  assert.match(text, /tool: "SubmitTask"/);
  assert.doesNotMatch(text, /tool: "FindSkills"/);
  assert.doesNotMatch(text, /tool: "ReadSkillResource"/);
  assert.doesNotMatch(text, /Old prompt that must not be repeated/);
  assert.doesNotMatch(text, /Old response that must not be repeated/);
  assert.equal(text.match(/initialPrompt:/g)?.length, 1);
  assert.match(text, /requestedDescription: "Research another BDD"/);
  assert.equal(existsSync(join(root, "logs", "runtime.log")), false);
  assert.equal(existsSync(join(logsRoot, "activity.log")), false);
});

test("AgentSkillRecorder writes Skill event metadata to a dedicated log", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-skill-recorder-"));
  const logsRoot = join(root, "agents", "researcher", "logs");
  const eventBus = new InMemoryEventBus();
  const registry = installTestRunScope(t, {
    runId: "run-skill-recorder",
    eventBus,
  }).agentRegistry;
  registerAgent(registry, "researcher", logsRoot);
  const recorder = new AgentSkillRecorder();
  recorder.start();

  const context = {
    agentId: "researcher",
    role: "researcher",
    taskId: "researcher-task-0001",
    threadId: "thread-researcher",
    turnId: "turn-1",
  } as const;
  await eventBus.publishAndWait(AgentEvents.skill.findCompleted, {
    ...context,
    callId: "call-find",
    phase: "research",
    family: ["validation", "researcher"],
    availableFamilies: [],
    status: "selected",
    candidateIds: ["domain-validation-researcher"],
    loadOrder: ["domain-validation-researcher"],
  } satisfies AgentSkillFindCompletedEvent);
  await eventBus.publishAndWait(AgentEvents.skill.readCompleted, {
    ...context,
    callId: "call-read",
    selectionId: "skill-selection-1",
    skillId: "domain-validation-researcher",
    resource: "SKILL.md",
    requirement: "required",
    selectionState: "ready",
    digest: "sha256:abc",
    byteLength: 123,
  } satisfies AgentSkillReadCompletedEvent);
  await eventBus.publishAndWait(AgentEvents.skill.readFailed, {
    ...context,
    callId: "call-read-failed",
    selectionId: "skill-selection-1",
    skillId: "domain-validation-researcher",
    resource: "templates/missing.md",
    errorCode: "load_order_violation",
  } satisfies AgentSkillReadFailedEvent);
  recorder.stop();

  const skillLogPath = join(logsRoot, "skill.log");
  const text = readFileSync(skillLogPath, "utf8");
  assert.equal(readEventCount(text), 3);
  assert.match(text, /event=agent\.skill\.find_completed/);
  assert.match(text, /event=agent\.skill\.read_completed/);
  assert.match(text, /event=agent\.skill\.read_failed/);
  assert.match(text, /family:/);
  assert.match(text, /- "validation"/);
  assert.match(text, /digest: "sha256:abc"/);
  assert.match(text, /requirement: "required"/);
  assert.match(text, /selectionState: "ready"/);
  assert.match(text, /resource: "templates\/missing\.md"/);
  assert.match(text, /errorCode: "load_order_violation"/);
  assert.doesNotMatch(text, /tags:/);
  assert.doesNotMatch(text, /SKILL_BODY_MUST_NOT_BE_RECORDED/);
  assert.equal(existsSync(join(root, "logs", "runtime.log")), false);
  assert.equal(existsSync(join(logsRoot, "activity.log")), false);
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
  assert.match(text, /- "agents\/researcher\.AGENTS\.md"/);
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
    phases: ["coordinate"],
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
  assert.match(text, /- "agents\/coordinator\.AGENTS\.md"/);
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
