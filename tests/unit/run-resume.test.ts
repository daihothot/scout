import assert from "node:assert/strict";
import test from "node:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachments } from "../../src/agent/context/attachments.js";
import { agent } from "../../src/agent/context/agent-attachments.js";
import type { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import { CoordinatorRunner } from "../../src/agent/runner/coordinator/coordinator-runner.js";
import { WorkerRunner } from "../../src/agent/runner/worker/worker-runner.js";
import {
  AgentTaskStepStatuses,
  AgentTaskStatuses,
  type AgentTaskState,
} from "../../src/agent/task/types.js";
import {
  ScoutAgentPhases,
  ScoutAgentRoles,
  type AgentThreadSpec,
} from "../../src/agent/thread/types.js";
import {
  type EventType,
  InMemoryEventBus,
  type ScoutEvent,
} from "../../src/core/events/index.js";
import type { Logger } from "../../src/core/logging/index.js";
import {
  ValidationDomain,
  ValidationEvents,
} from "../../src/domain/index.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/index.js";
import {
  RunJournal,
  RunJournalWriter,
  type RunJournalEvent,
} from "../../src/run/journal/index.js";
import { RunEvents } from "../../src/run/events/index.js";
import { buildResumePacket } from "../../src/run/resume/packet/index.js";
import {
  inferTaskRecoveryCheckpoint,
  planResumeActions,
  projectRun,
  ResumeActionTypes,
  TaskRecoveryCheckpoints,
} from "../../src/run/resume/projection/index.js";
import {
  currentRunScope,
  installRunScope,
  RunScope,
} from "../../src/run/run-scope.js";
import { RunManifestStore } from "../../src/run/persistence/index.js";
import {
  InitializeRunStage,
  PrepareEnvironmentStage,
} from "../../src/run/startup/index.js";
import {
  InjectResumeContextStage,
  RecordResumeInterruptionsStage,
  RestoreDomainStage,
  RestoreEnvironmentStage,
  RestoreTasksStage,
} from "../../src/run/resume/index.js";
import { SystemEvents } from "../../src/system/events/index.js";
import {
  AgentBackendStage,
  AgentTelemetryStage,
  AgentsStage,
  DomainStage,
  InteractionStage,
  OrchestratorStage,
  RunJournalWriterStage,
  RunRuntimeStage,
  RunScopeStage,
  RunStageExecutor,
  type RunStage,
} from "../../src/run/lifecycle/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("Run projection rebuilds pending messages, human gate and interrupted turn", () => {
  const events = journalEvents(
    scoutEvent(AgentEvents.task.assigned, taskState()),
    scoutEvent(SystemEvents.interaction.userMessageSubmitted, {
      messageId: "user-message-unqueued",
      text: "尚未入队的用户输入",
      attachment: agent.turn.message("尚未入队的用户输入"),
      submittedAt: "2026-07-22T00:00:00.500Z",
    }),
    scoutEvent(AgentEvents.message.queued, {
      messageId: "message-1",
      agentId: "researcher",
      taskId: "researcher-task-0001",
      body: agent.turn.message("继续处理"),
      queuedAt: "2026-07-22T00:00:01.000Z",
    }),
    scoutEvent(AgentEvents.message.queued, {
      messageId: "message-2",
      agentId: "researcher",
      taskId: "researcher-task-0001",
      body: agent.turn.message("保留消息"),
      queuedAt: "2026-07-22T00:00:02.000Z",
    }),
    scoutEvent(AgentEvents.message.consumed, {
      messageId: "message-1",
      agentId: "researcher",
      taskId: "researcher-task-0001",
      consumedAt: "2026-07-22T00:00:03.000Z",
    }),
    scoutEvent(AgentEvents.humanInput.requested, {
      requestId: "human-1",
      taskId: "researcher-task-0001",
      agentId: "researcher",
      body: "请确认版本。",
      requestedAt: "2026-07-22T00:00:04.000Z",
      message: {
        messageId: "human-1-request",
        agentId: "coordinator",
        body: agent.turn.wait_for_human_request("请确认版本。"),
        queuedAt: "2026-07-22T00:00:04.000Z",
      },
    }),
    scoutEvent(AgentEvents.turn.started, {
      invocationId: "invocation-1",
      agentId: "researcher",
      role: ScoutAgentRoles.Researcher,
      taskId: "researcher-task-0001",
      threadId: "thread-old",
      prompt: agent.turn.message("中断输入"),
      startedAt: "2026-07-22T00:00:05.000Z",
    }),
  );
  const projection = projectRun(events);

  assert.deepEqual(
    projection.pendingMessages.map((message) => message.messageId),
    ["user-message-unqueued", "message-2", "human-1-request"],
  );
  assert.deepEqual(
    projection.messageDeliveries.map((message) => message.messageId),
    ["message-1", "message-2"],
  );
  assert.equal(projection.turns[0]?.completedAt, undefined);
  assert.equal(
    inferTaskRecoveryCheckpoint(projection, projection.tasks[0]),
    TaskRecoveryCheckpoints.WaitingForHumanInput,
  );
});

test("Run projection derives an outcome checkpoint and no checkpoint without a task", () => {
  const doneTask = { ...taskState(), status: AgentTaskStatuses.Done };
  const doneProjection = projectRun(journalEvents(
    scoutEvent(AgentEvents.task.assigned, taskState()),
    scoutEvent(AgentEvents.task.outcomeSubmitted, {
      task: doneTask,
      stepId: "step-1",
      outcome: "## Outcome\n\n已完成。",
      submittedAt: "2026-07-22T00:01:00.000Z",
    }),
  ));
  assert.equal(
    inferTaskRecoveryCheckpoint(doneProjection, doneProjection.tasks[0]),
    TaskRecoveryCheckpoints.OutcomeSubmitted,
  );

  const idleProjection = projectRun(journalEvents());
  assert.equal(inferTaskRecoveryCheckpoint(idleProjection, undefined), undefined);
});

test("Terminal task checkpoints ignore stale unresolved human requests", () => {
  for (const status of [AgentTaskStatuses.Failed, AgentTaskStatuses.Stopped] as const) {
    const task = taskState({ status, error: `${status} reason` });
    const projection = projectRun(journalEvents(
      scoutEvent(AgentEvents.task.assigned, taskState()),
      scoutEvent(AgentEvents.humanInput.requested, {
        requestId: `${status}-request`,
        taskId: task.taskId,
        agentId: task.agentId,
        body: "终态前遗留请求",
        requestedAt: "2026-07-22T00:01:00.000Z",
        message: {
          messageId: `${status}-request-message`,
          agentId: "coordinator",
          body: agent.turn.wait_for_human_request("终态前遗留请求"),
          queuedAt: "2026-07-22T00:01:00.000Z",
        },
      }),
      scoutEvent(
        status === AgentTaskStatuses.Failed
          ? AgentEvents.task.failed
          : AgentEvents.task.stopped,
        task,
      ),
    ));

    assert.equal(
      inferTaskRecoveryCheckpoint(projection, projection.tasks[0]),
      TaskRecoveryCheckpoints.Terminated,
    );
    assert.deepEqual(projection.pendingMessages, []);
    const body = attachments.readTagBlock(buildPlannedResumePacket({
      projection,
      agentId: "coordinator",
      role: ScoutAgentRoles.Coordinator,
      assetCommitId: "ac-coordinator",
    }), "resume")[0]?.body;
    const packet = JSON.parse(body ?? "{}") as {
      tasks?: Array<{ recovery_checkpoint?: string }>;
      resume_actions?: Array<{ type?: string; task_id?: string; message_id?: string }>;
      open?: Array<{ type?: string }>;
    };
    assert.equal(
      packet.tasks?.[0]?.recovery_checkpoint,
      TaskRecoveryCheckpoints.Terminated,
    );
    assert.deepEqual(
      packet.resume_actions?.map((action) => ({
        type: action.type,
        task_id: action.task_id,
        message_id: action.message_id,
      })),
      [
        {
          type: ResumeActionTypes.ResolveTermination,
          task_id: task.taskId,
          message_id: undefined,
        },
      ],
    );
    assert.equal(
      packet.open?.some((entry) => entry.type === "human_input_request"),
      false,
    );
  }
});

test("Coordinator resume actions compose independent task checkpoints without priority collapse", () => {
  const reportedTask = taskState({
    taskId: "researcher-task-reported",
    status: AgentTaskStatuses.Done,
  });
  const interruptedTask = taskState({
    taskId: "verifier-task-interrupted",
    agentId: ScoutAgentRoles.Verifier,
    role: ScoutAgentRoles.Verifier,
    steps: [{
      stepId: "verifier-task-interrupted-step-0001",
      taskId: "verifier-task-interrupted",
      status: AgentTaskStepStatuses.Interrupted,
      prompt: agent.turn.message("恢复中断验证"),
      toolCalls: [],
      startedAt: "2026-07-22T00:00:01.000Z",
      finishedAt: "2026-07-22T00:00:02.000Z",
    }],
  });
  const terminatedTask = taskState({
    taskId: "validator-task-terminated",
    agentId: ScoutAgentRoles.Validator,
    role: ScoutAgentRoles.Validator,
    status: AgentTaskStatuses.Failed,
    error: "检查失败",
  });
  const projection = projectRun(journalEvents(
    scoutEvent(AgentEvents.task.assigned, taskState({
      taskId: reportedTask.taskId,
    })),
    scoutEvent(AgentEvents.task.outcomeSubmitted, {
      task: reportedTask,
      stepId: "researcher-task-reported-step-0001",
      outcome: "## Outcome\n\nResearch 已完成。",
      submittedAt: "2026-07-22T00:01:00.000Z",
    }),
    scoutEvent(AgentEvents.task.assigned, interruptedTask),
    scoutEvent(AgentEvents.task.assigned, taskState({
      taskId: terminatedTask.taskId,
      agentId: terminatedTask.agentId,
      role: terminatedTask.role,
    })),
    scoutEvent(AgentEvents.task.failed, terminatedTask),
  ));

  assert.deepEqual(
    projection.tasks.map((task) => ({
      taskId: task.taskId,
      checkpoint: inferTaskRecoveryCheckpoint(projection, task),
    })),
    [
      {
        taskId: reportedTask.taskId,
        checkpoint: TaskRecoveryCheckpoints.OutcomeSubmitted,
      },
      {
        taskId: interruptedTask.taskId,
        checkpoint: TaskRecoveryCheckpoints.Interrupted,
      },
      {
        taskId: terminatedTask.taskId,
        checkpoint: TaskRecoveryCheckpoints.Terminated,
      },
    ],
  );
  assert.deepEqual(
    planResumeActions({
      projection,
      agentId: ScoutAgentRoles.Coordinator,
      role: ScoutAgentRoles.Coordinator,
    }),
    [
      {
        type: ResumeActionTypes.EvaluateOutcome,
        taskId: reportedTask.taskId,
      },
      {
        type: ResumeActionTypes.InspectInterruption,
        taskId: interruptedTask.taskId,
      },
      {
        type: ResumeActionTypes.ResolveTermination,
        taskId: terminatedTask.taskId,
      },
    ],
  );
});

test("Coordinator Resume Packet processes pending user input without duplicating its body", () => {
  const projection = projectRun(journalEvents(
    scoutEvent(SystemEvents.interaction.userMessageSubmitted, {
      messageId: "pending-user-message",
      text: "只投递一次的用户正文",
      attachment: agent.turn.message("只投递一次的用户正文"),
      submittedAt: "2026-07-22T00:01:00.000Z",
    }),
  ));
  const body = attachments.readTagBlock(buildPlannedResumePacket({
    projection,
    agentId: "coordinator",
    role: ScoutAgentRoles.Coordinator,
    assetCommitId: "ac-coordinator",
  }), "resume")[0]?.body;
  const packet = JSON.parse(body ?? "{}") as {
    resume_actions?: Array<{ type?: string; message_id?: string }>;
    pending_messages?: Array<{ message_id?: string }>;
  };

  assert.deepEqual(packet.resume_actions?.map((action) => ({
    type: action.type,
    message_id: action.message_id,
  })), [{
    type: ResumeActionTypes.ConsumeMessage,
    message_id: "pending-user-message",
  }]);
  assert.deepEqual(packet.pending_messages, [{
    message_id: "pending-user-message",
    queued_at: "2026-07-22T00:01:00.000Z",
  }]);
  assert.doesNotMatch(body ?? "", /只投递一次的用户正文/);
});

test("Pending human responses stay in the delivery queue instead of Resume Packet confirmed facts", () => {
  const task = taskState();
  const projection = projectRun(journalEvents(
    scoutEvent(AgentEvents.task.assigned, task),
    scoutEvent(AgentEvents.humanInput.requested, {
      requestId: "human-response-pending",
      taskId: task.taskId,
      agentId: task.agentId,
      body: "请选择目标。",
      requestedAt: "2026-07-22T00:01:00.000Z",
      message: {
        messageId: "human-request-consumed",
        agentId: "coordinator",
        body: agent.turn.wait_for_human_request("请选择目标。"),
        queuedAt: "2026-07-22T00:01:00.000Z",
      },
    }),
    scoutEvent(AgentEvents.message.consumed, {
      messageId: "human-request-consumed",
      agentId: "coordinator",
      consumedAt: "2026-07-22T00:01:01.000Z",
    }),
    scoutEvent(AgentEvents.humanInput.responded, {
      requestId: "human-response-pending",
      taskId: task.taskId,
      agentId: task.agentId,
      body: "使用测试账号。",
      respondedAt: "2026-07-22T00:01:02.000Z",
      message: {
        messageId: "human-response-message",
        agentId: task.agentId,
        taskId: task.taskId,
        body: agent.turn.human_response("使用测试账号。"),
        queuedAt: "2026-07-22T00:01:02.000Z",
      },
    }),
  ));
  const body = attachments.readTagBlock(buildPlannedResumePacket({
    projection,
    agentId: task.agentId,
    role: task.role,
    assetCommitId: "ac-researcher",
  }), "resume")[0]?.body;

  assert.doesNotMatch(body ?? "", /使用测试账号/);
  assert.match(body ?? "", /human-response-message/);
});

test("Archived tasks do not retain unresolved Human Gates or their pending delivery", () => {
  const task = taskState();
  const projection = projectRun(journalEvents(
    scoutEvent(AgentEvents.task.assigned, task),
    scoutEvent(AgentEvents.humanInput.requested, {
      requestId: "archived-request",
      taskId: task.taskId,
      agentId: task.agentId,
      body: "已经失效的请求",
      requestedAt: "2026-07-22T00:01:00.000Z",
      message: {
        messageId: "archived-request-message",
        agentId: "coordinator",
        body: agent.turn.wait_for_human_request("已经失效的请求"),
        queuedAt: "2026-07-22T00:01:00.000Z",
      },
    }),
    scoutEvent(
      AgentEvents.task.archived,
      task,
      "2026-07-22T00:01:01.000Z",
    ),
  ));

  assert.deepEqual(projection.pendingMessages, []);
  const body = attachments.readTagBlock(buildPlannedResumePacket({
    projection,
    agentId: "coordinator",
    role: ScoutAgentRoles.Coordinator,
    assetCommitId: "ac-coordinator",
  }), "resume")[0]?.body;
  assert.doesNotMatch(body ?? "", /human_input_request|已经失效的请求/);
});

test("Resume Packet is deterministic, role-scoped and escapes closing tags", () => {
  const researcher = taskState();
  const validator = taskState({
    taskId: "validator-task-0001",
    agentId: "validator",
    role: ScoutAgentRoles.Validator,
    description: "检查私有信息",
    initialPrompt: agent.turn.message("validator secret"),
  });
  const projection = projectRun(journalEvents(
    scoutEvent(AgentEvents.task.assigned, researcher),
    scoutEvent(AgentEvents.task.assigned, validator),
    scoutEvent(AgentEvents.message.queued, {
      messageId: "research-message",
      agentId: "researcher",
      taskId: researcher.taskId,
      body: agent.turn.message("文本包含 </resume> 但必须安全"),
      queuedAt: "2026-07-22T00:00:01.000Z",
    }),
  ));
  const input = {
    projection,
    agentId: "researcher",
    role: ScoutAgentRoles.Researcher,
    assetCommitId: "ac_research",
  } as const;
  const first = buildPlannedResumePacket(input);
  const second = buildPlannedResumePacket(input);
  const body = attachments.readTagBlock(first, "resume")[0]?.body;

  assert.equal(first, second);
  assert.ok(body);
  assert.doesNotMatch(first.slice(0, first.lastIndexOf("</resume>")), /<\/resume>/);
  const packet = JSON.parse(body ?? "{}") as Record<string, unknown>;
  assert.match(JSON.stringify(packet), /researcher-task-0001/);
  assert.doesNotMatch(JSON.stringify(packet), /validator secret/);
});

test("Resume Packet bounds long outcomes and keeps artifact refs without message duplication", () => {
  const task = taskState({ status: AgentTaskStatuses.Done });
  const longOutcome = "很长的结论".repeat(1000);
  const artifactRef = "agents/researcher/artifacts/research-pack/evidence/E-CODE-001.md";
  const projection = projectRun(journalEvents(
    scoutEvent(AgentEvents.task.assigned, taskState()),
    ...Array.from({ length: 12 }, (_, index) =>
      scoutEvent(AgentEvents.task.outcomeSubmitted, {
        task,
        stepId: `step-${index + 1}`,
        outcome: longOutcome,
        submittedAt: `2026-07-22T00:01:${String(index).padStart(2, "0")}.000Z`,
      })
    ),
    scoutEvent(ValidationEvents.artifact.published, {
      artifactId: "artifact-1",
      taskId: task.taskId,
      agentId: task.agentId,
      role: task.role,
      ref: artifactRef,
      digest: "sha256:artifact",
      status: "published",
      publishedAt: "2026-07-22T00:02:00.000Z",
    }),
    scoutEvent(AgentEvents.message.queued, {
      messageId: "pending-1",
      agentId: "coordinator",
      body: agent.turn.message("只应由恢复队列投递一次"),
      queuedAt: "2026-07-22T00:03:00.000Z",
    }),
  ));
  const rendered = buildPlannedResumePacket({
    projection,
    agentId: "coordinator",
    role: ScoutAgentRoles.Coordinator,
    assetCommitId: "ac_coordinator",
  });
  const body = attachments.readTagBlock(rendered, "resume")[0]?.body;
  const packet = JSON.parse(body ?? "{}") as Record<string, unknown>;
  const workerBody = attachments.readTagBlock(buildPlannedResumePacket({
    projection,
    agentId: "researcher",
    role: ScoutAgentRoles.Researcher,
    assetCommitId: "ac_researcher",
  }), "resume")[0]?.body;
  const workerPacket = JSON.parse(workerBody ?? "{}") as {
    reported?: Array<{ outcome?: { truncated?: boolean } }>;
  };

  assert.ok(Buffer.byteLength(body ?? "", "utf8") <= 12 * 1024);
  assert.match(JSON.stringify(packet), new RegExp(artifactRef));
  assert.doesNotMatch(JSON.stringify(packet), /只应由恢复队列投递一次/);
  assert.equal(workerPacket.reported?.[0]?.outcome?.truncated, true);
});

test("WorkerRunner injects restored context once and consumes restored messages once", async (t) => {
  const eventBus = new InMemoryEventBus();
  installTestRunScope(t, {
    runId: "worker-runner-restored-context",
    eventBus,
  });
  const consumedMessageIds: string[] = [];
  eventBus.subscribe(AgentEvents.message.consumed, (event) => {
    if (AgentEvents.message.consumed.is(event)) {
      consumedMessageIds.push(event.payload.messageId);
    }
  });
  const prompts: string[] = [];
  const task = taskState({ startedAt: "2026-07-22T00:00:00.000Z" });
  const consumedDelivery = {
    messageId: "consumed-before-resume",
    agentId: "researcher",
    taskId: task.taskId,
    body: agent.turn.message("恢复前已消费"),
    queuedAt: "2026-07-22T00:00:00.500Z",
  };
  const runner = new WorkerRunner({
    host: workerHost(async (input) => {
      prompts.push(input.prompt);
      return completedTurn(`turn-${prompts.length}`);
    }),
    taskSequence: 1,
    restoredTask: task,
  });
  runner.restoreState({
    acceptedMessages: [consumedDelivery],
    pendingMessages: [{
      messageId: "restored-message",
      agentId: "researcher",
      taskId: task.taskId,
      body: agent.turn.message("恢复消息"),
      queuedAt: "2026-07-22T00:00:01.000Z",
    }],
    resumeContext: attachments.addTagBlock(
      "resume",
      JSON.stringify({
        task_recovery_checkpoint: TaskRecoveryCheckpoints.Resumable,
        resume_actions: [{
          type: ResumeActionTypes.ResumeTask,
          task_id: task.taskId,
        }],
      }),
    ),
    resumeImmediately: true,
  });

  await Promise.resolve();
  assert.equal(prompts.length, 0);
  runner.activateRestoredTask();
  await runner.runTasksToIdle();
  await runner.queueMessage({ taskId: task.taskId, message: agent.turn.message("下一轮") });
  await runner.runTasksToIdle();

  assert.equal(prompts.length, 2);
  assert.match(prompts[0] ?? "", /<resume>/);
  assert.match(prompts[0] ?? "", /恢复消息/);
  assert.doesNotMatch(prompts[1] ?? "", /<resume>/);
  assert.equal(
    consumedMessageIds.filter((messageId) => messageId === "restored-message").length,
    1,
  );
  await runner.queueMessage({
    taskId: task.taskId,
    message: consumedDelivery.body,
    delivery: {
      messageId: consumedDelivery.messageId,
      queuedAt: consumedDelivery.queuedAt,
    },
  });
  await runner.runTasksToIdle();
  assert.equal(prompts.length, 2);
  await assert.rejects(
    runner.queueMessage({
      taskId: task.taskId,
      message: agent.turn.message("冲突正文"),
      delivery: {
        messageId: consumedDelivery.messageId,
        queuedAt: consumedDelivery.queuedAt,
      },
    }),
    /does not match its Worker delivery/,
  );
});

test("CoordinatorRunner restores accepted delivery ids without replaying them", async (t) => {
  const eventBus = new InMemoryEventBus();
  installTestRunScope(t, {
    runId: "coordinator-runner-restored-deliveries",
    eventBus,
  });
  const accepted = {
    messageId: "coordinator-consumed-before-resume",
    agentId: "coordinator",
    body: agent.turn.message("恢复前已消费"),
    queuedAt: "2026-07-22T00:00:00.500Z",
  };
  const runner = new CoordinatorRunner({
    host: {
      agentId: "coordinator",
      runTurn: async () => {
        throw new Error("Accepted delivery must not start another Coordinator turn.");
      },
    },
  });
  runner.restoreState({
    acceptedMessages: [accepted],
    pendingMessages: [],
    resumeContext: "",
  });

  await runner.queueMessage({
    message: accepted.body,
    delivery: {
      messageId: accepted.messageId,
      queuedAt: accepted.queuedAt,
    },
  });
  assert.equal(runner.snapshot().pendingMessageCount, 0);
  await assert.rejects(
    runner.queueMessage({
      message: agent.turn.message("冲突正文"),
      delivery: {
        messageId: accepted.messageId,
        queuedAt: accepted.queuedAt,
      },
    }),
    /does not match its Coordinator delivery/,
  );
  await runner.stop("test_complete");
});

test("resume stages restore tasks, messages, interruptions and Validation artifacts from a Test RunScope", async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-run-resume-flow-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(process.cwd(), "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });

  const runId = "run-resume-flow";
  const runRoot = join(fixtureRoot, "run", runId);
  const initialJournal = RunJournal.create({ runId, runRoot });
  const initialManifestStore = new RunManifestStore(runRoot);
  const initialEventBus = new InMemoryEventBus();
  const initialScope = new RunScope({
    runId,
    repoRoot: fixtureRoot,
    logger: noopLogger(),
    eventBus: initialEventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: new ValidationDomain(),
    journal: initialJournal,
    manifestStore: initialManifestStore,
    terminate: async () => undefined,
  });
  const releaseInitialScope = installRunScope(initialScope);
  const initialJournalWriter = new RunJournalWriter();
  initialJournalWriter.start();
  await new InitializeRunStage().start();
  await new PrepareEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();

  const researchPackRef = "agents/researcher/artifacts/account-anon-restore-existing-account-research-pack";
  const researchPack = join(runRoot, researchPackRef);
  mkdirSync(researchPack, { recursive: true });
  writeFileSync(join(researchPack, "index.md"), "# Research Pack\n\n恢复证据。\n", "utf8");
  const gateRef = "agents/validator/artifacts/research-pack-gate-0001.md";
  writeFileSync(join(runRoot, gateRef), [
    "---",
    "artifact_type: ResearchPackGate",
    "artifact_version: 1",
    "status: ready",
    "completion_state: complete",
    "gate: needs_fix",
    'gate_id: "gate-0001"',
    'created_at: "2026-07-22T00:02:00.000Z"',
    'validator_task_id: "validator-task-0001"',
    `checked_pack_ref: "${researchPackRef}"`,
    'checked_pack_digest: "sha256:research-pack"',
    "---",
    "",
    "# Validator Handoff: Research Pack Gate",
    "",
    "需要修正。",
    "",
  ].join("\n"), "utf8");

  const researcherTask = taskState({
    startedAt: "2026-07-22T00:00:00.000Z",
    steps: [{
      stepId: "researcher-task-0001-step-0001",
      taskId: "researcher-task-0001",
      status: AgentTaskStepStatuses.Running,
      prompt: agent.turn.message("恢复前中断的 Research step"),
      toolCalls: [],
      startedAt: "2026-07-22T00:00:01.000Z",
    }],
  });
  const validatorTask = taskState({
    taskId: "validator-task-0001",
    agentId: ScoutAgentRoles.Validator,
    role: ScoutAgentRoles.Validator,
    description: "检查 Research Pack",
    initialPrompt: agent.turn.message("检查 Research Pack"),
    startedAt: "2026-07-22T00:00:00.000Z",
  });
  const verifierRunning = taskState({
    taskId: "verifier-task-0001",
    agentId: ScoutAgentRoles.Verifier,
    role: ScoutAgentRoles.Verifier,
    description: "历史失败任务",
    initialPrompt: agent.turn.message("历史失败任务"),
  });
  const verifierFailed = {
    ...verifierRunning,
    status: AgentTaskStatuses.Failed,
    error: "历史运行失败",
    finishedAt: "2026-07-22T00:00:05.000Z",
    updatedAt: "2026-07-22T00:00:05.000Z",
  } satisfies AgentTaskState;
  await initialEventBus.publishAndWait(
    AgentEvents.task.assigned,
    researcherTask,
    { occurredAt: researcherTask.createdAt },
  );
  await initialEventBus.publishAndWait(
    AgentEvents.task.assigned,
    validatorTask,
    { occurredAt: validatorTask.createdAt },
  );
  await initialEventBus.publishAndWait(
    AgentEvents.task.assigned,
    verifierRunning,
    { occurredAt: verifierRunning.createdAt },
  );
  await initialEventBus.publishAndWait(
    AgentEvents.task.failed,
    verifierFailed,
    { occurredAt: verifierFailed.updatedAt },
  );
  await initialEventBus.publishAndWait(AgentEvents.turn.started, {
    invocationId: "researcher-old-invocation",
    agentId: ScoutAgentRoles.Researcher,
    role: ScoutAgentRoles.Researcher,
    taskId: researcherTask.taskId,
    threadId: "researcher-old-thread",
    prompt: researcherTask.steps?.[0]?.prompt ?? "",
    startedAt: "2026-07-22T00:00:01.000Z",
  }, {
    occurredAt: "2026-07-22T00:00:01.000Z",
  });
  await initialEventBus.publishAndWait(
    SystemEvents.interaction.userMessageSubmitted,
    {
      messageId: "pending-user-input",
      text: "用户待处理输入",
      attachment: agent.turn.message("用户待处理输入"),
      submittedAt: "2026-07-22T00:00:06.000Z",
    },
    { occurredAt: "2026-07-22T00:00:06.000Z" },
  );
  await initialEventBus.publishAndWait(AgentEvents.humanInput.requested, {
    requestId: "researcher-human",
    taskId: researcherTask.taskId,
    agentId: researcherTask.agentId,
    body: "请确认 Researcher 版本",
    requestedAt: "2026-07-22T00:00:07.000Z",
    message: {
      messageId: "researcher-human-request",
      agentId: ScoutAgentRoles.Coordinator,
      body: agent.turn.wait_for_human_request("请确认 Researcher 版本"),
      queuedAt: "2026-07-22T00:00:07.000Z",
    },
  }, {
    occurredAt: "2026-07-22T00:00:07.000Z",
  });
  await initialEventBus.publishAndWait(
    AgentEvents.message.consumed,
    {
      messageId: "researcher-human-request",
      agentId: ScoutAgentRoles.Coordinator,
      consumedAt: "2026-07-22T00:00:08.000Z",
    },
    { occurredAt: "2026-07-22T00:00:08.000Z" },
  );
  await initialEventBus.publishAndWait(AgentEvents.humanInput.responded, {
    requestId: "researcher-human",
    taskId: researcherTask.taskId,
    agentId: researcherTask.agentId,
    body: "已确认 Researcher 版本",
    respondedAt: "2026-07-22T00:00:09.000Z",
    message: {
      messageId: "researcher-human-response",
      agentId: researcherTask.agentId,
      taskId: researcherTask.taskId,
      body: agent.turn.human_response("已确认 Researcher 版本"),
      queuedAt: "2026-07-22T00:00:09.000Z",
    },
  }, {
    occurredAt: "2026-07-22T00:00:09.000Z",
  });
  await initialEventBus.publishAndWait(AgentEvents.humanInput.requested, {
    requestId: "validator-human",
    taskId: validatorTask.taskId,
    agentId: validatorTask.agentId,
    body: "请确认 Validator 的边界",
    requestedAt: "2026-07-22T00:00:10.000Z",
    message: {
      messageId: "validator-human-request",
      agentId: ScoutAgentRoles.Coordinator,
      body: agent.turn.wait_for_human_request("请确认 Validator 的边界"),
      queuedAt: "2026-07-22T00:00:10.000Z",
    },
  }, {
    occurredAt: "2026-07-22T00:00:10.000Z",
  });
  initialJournalWriter.stop();
  releaseInitialScope();
  initialJournal.close();
  assert.equal(existsSync(join(runRoot, ".run.lock")), false);

  const resumedPrompts: string[] = [];
  let dynamicToolHandlerInstalled = false;
  let releaseResumedTurns: (() => void) | undefined;
  const resumedTurnsRelease = new Promise<void>((resolve) => {
    releaseResumedTurns = resolve;
  });
  let markResumedTurnsStarted: (() => void) | undefined;
  const resumedTurnsStarted = new Promise<void>((resolve) => {
    markResumedTurnsStarted = resolve;
  });
  let threadSequence = 0;
  let turnSequence = 0;
  const appServer = {
    close() {},
    async startThread(startInput: Record<string, unknown>) {
      threadSequence += 1;
      const threadId = `fake-thread-${threadSequence}`;
      return {
        threadId,
        startInput,
        response: { thread: { id: threadId } },
      };
    },
    async request(method: string, params: unknown) {
      if (method === "config/read") return { layers: [] };
      if (method === "plugin/installed") {
        const names = (
          params as { installSuggestionPluginNames?: string[] }
        ).installSuggestionPluginNames ?? [];
        return {
          marketplaces: [{
            plugins: names.map((name) => ({
              name,
              installed: true,
              enabled: true,
            })),
          }],
        };
      }
      return {};
    },
    async runTurn(turnInput: { prompt: string }) {
      turnSequence += 1;
      resumedPrompts.push(turnInput.prompt);
      if (resumedPrompts.length === 2) markResumedTurnsStarted?.();
      await resumedTurnsRelease;
      return {
        turnId: `fake-turn-${turnSequence}`,
        finalResponse: "恢复状态已处理。",
        progressItems: [],
      };
    },
    setDynamicToolCallHandler() {
      dynamicToolHandlerInstalled = true;
      return () => {
        dynamicToolHandlerInstalled = false;
      };
    },
    onTimeline() {
      return () => undefined;
    },
    resolveTimelineEntry() {
      return undefined;
    },
  } as unknown as CodexAppServerClient;
  const resumedJournal = RunJournal.open({ runId, runRoot });
  const resumedManifestStore = new RunManifestStore(runRoot);
  const resumedEventBus = new InMemoryEventBus();
  const executor = new RunStageExecutor({
    runId,
    logger: noopLogger(),
  });
  const scope = new RunScope({
    runId,
    repoRoot: fixtureRoot,
    logger: noopLogger(),
    eventBus: resumedEventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: new ValidationDomain(),
    journal: resumedJournal,
    manifestStore: resumedManifestStore,
    terminate: (reason) => executor.terminate(reason),
  });
  scope.setAppServer(appServer);
  const releaseResumedScope = installRunScope(scope);
  const injectResumeContextStage = new InjectResumeContextStage();
  executor.registerSerial(
    new RunJournalWriterStage(),
    new RecordResumeInterruptionsStage(),
    new RunRuntimeStage("resume"),
    new RestoreEnvironmentStage(),
    new InteractionStage(),
  );
  executor.registerParallel(new DomainStage(), new AgentTelemetryStage());
  executor.registerSerial(new RestoreDomainStage());
  executor.registerParallel(new AgentBackendStage(), new OrchestratorStage());
  executor.registerSerial(
    new AgentsStage(),
    new RestoreTasksStage(),
    injectResumeContextStage,
  );
  t.after(async () => {
    releaseResumedTurns?.();
    if (executor.snapshot().status !== "terminated") {
      await executor.terminate("test_resume_cleanup");
    }
    scope.clearAppServer(appServer);
    releaseResumedScope();
  });
  await executor.startup();
  injectResumeContextStage.activate();
  await resumedTurnsStarted;

  const restoredManifest = resumedManifestStore.read();
  assert.equal(restoredManifest.version, 2);
  assert.equal("environment" in restoredManifest, false);
  assert.equal("assetCommitId" in restoredManifest, false);
  assert.deepEqual(
    Object.keys(restoredManifest.agents ?? {}).sort(),
    Object.values(ScoutAgentRoles).sort(),
  );
  for (const role of Object.values(ScoutAgentRoles)) {
    const restoredAgent = scope.environment.agents[role];
    const entry = restoredManifest.agents?.[role];
    assert.ok(entry);
    assert.equal(restoredAgent.mount.mountId, entry.mountId);
    assert.equal(restoredAgent.assetCommit.assetCommitId, entry.assetCommitId);
    assert.equal(restoredAgent.assetCommit.resourceHash, entry.resourceHash);
    assert.equal(restoredAgent.preflight.status, "passed");
  }
  assert.equal(
    scope.contextBundle.assetCommit.assetCommitId,
    scope.environment.agents[ScoutAgentRoles.Coordinator].assetCommit.assetCommitId,
  );
  assert.ok(scope.environment.rootAccess.mountRoots.every((root) =>
    root.startsWith(runRoot)
  ));

  const restoredEvents = scope.journal.readAll();
  const projection = projectRun(restoredEvents);
  const restoredResearcher = projection.tasks.find((task) =>
    task.taskId === researcherTask.taskId
  );
  assert.equal(restoredResearcher?.status, AgentTaskStatuses.Running);
  assert.equal(
    restoredResearcher?.steps?.[0]?.status,
    AgentTaskStepStatuses.Interrupted,
  );
  assert.ok(restoredEvents.some((event) =>
    AgentEvents.task.stepInterrupted.is(event)
    && event.payload.steps?.some((step) =>
      step.stepId === "researcher-task-0001-step-0001"
      && step.status === AgentTaskStepStatuses.Interrupted
    )
  ));
  assert.equal(
    projection.turns.find((turn) => turn.invocationId === "researcher-old-invocation")?.status,
    "interrupted",
  );
  assert.ok(projection.artifacts.some((artifact) => artifact.ref === researchPackRef));
  assert.ok(projection.artifacts.some((artifact) => artifact.ref === gateRef));
  assert.equal(projection.gates[0]?.gateId, "gate-0001");
  assert.equal(projection.gates[0]?.status, "needs_fix");
  assert.deepEqual(projection.pendingMessages, []);
  assert.equal(
    restoredEvents.filter((event) =>
      AgentEvents.message.consumed.is(event)
      && event.payload.messageId === "researcher-human-response"
    ).length,
    1,
  );
  assert.equal(
    restoredEvents.filter((event) =>
      AgentEvents.message.consumed.is(event)
      && event.payload.messageId === "pending-user-input"
    ).length,
    1,
  );
  assert.equal(
    restoredEvents.filter((event) =>
      AgentEvents.message.consumed.is(event)
      && event.payload.messageId === "validator-human-request"
    ).length,
    1,
  );

  const coordinatorPrompt = resumedPrompts.find((prompt) =>
    prompt.includes("用户待处理输入")
  ) ?? "";
  const researcherPrompt = resumedPrompts.find((prompt) =>
    prompt.includes("已确认 Researcher 版本")
  ) ?? "";
  assert.match(coordinatorPrompt, /<resume>/);
  assert.match(coordinatorPrompt, /inspect_interruption/);
  assert.match(coordinatorPrompt, /resolve_termination/);
  assert.match(coordinatorPrompt, new RegExp(researchPackRef));
  assert.match(coordinatorPrompt, new RegExp(gateRef));
  assert.equal(coordinatorPrompt.split("用户待处理输入").length - 1, 1);
  assert.equal(coordinatorPrompt.split("请确认 Validator 的边界").length - 1, 1);
  assert.doesNotMatch(coordinatorPrompt, /已确认 Researcher 版本/);
  assert.match(researcherPrompt, /<resume>/);
  assert.equal(researcherPrompt.split("已确认 Researcher 版本").length - 1, 1);

  const termination = scope.terminate("test_resume_termination");
  await Promise.resolve();
  assert.equal(dynamicToolHandlerInstalled, true);
  releaseResumedTurns?.();
  await termination;
  assert.equal(dynamicToolHandlerInstalled, false);
  assert.equal(existsSync(join(runRoot, ".run.lock")), false);
});

test("ValidationDomain records artifacts after an accepted task outcome event", async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-validation-artifact-event-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(process.cwd(), "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  const runId = "validation-artifact-event";
  const eventBus = new InMemoryEventBus();
  const scope = installTestRunScope(t, {
    runId,
    repoRoot: fixtureRoot,
    eventBus,
    domain: new ValidationDomain(),
  });
  await new PrepareEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();
  const domainStage = new DomainStage();
  await domainStage.start();

  const artifactRef = "agents/researcher/artifacts/account-anon-restore-existing-account-research-pack";
  const artifactPath = join(
    scope.environment.agents[ScoutAgentRoles.Researcher].mount.artifactRoot,
    "account-anon-restore-existing-account-research-pack",
  );
  mkdirSync(artifactPath, { recursive: true });
  writeFileSync(join(artifactPath, "index.md"), "# Research Pack\n\n事件驱动证据。\n", "utf8");
  assert.equal(
    scope.journal.readAll().some((event) => ValidationEvents.artifact.published.is(event)),
    false,
  );

  const task = taskState({
    status: AgentTaskStatuses.Done,
    updatedAt: "2026-07-23T00:00:00.000Z",
  });
  await scope.eventBus.publishAndWait(AgentEvents.task.outcomeSubmitted, {
    task,
    stepId: `${task.taskId}-step-0001`,
    outcome: "## Outcome\n\n- Research Pack 已提交。",
    submittedAt: task.updatedAt,
  }, {
    occurredAt: task.updatedAt,
  });

  const artifactEvent = scope.journal.readAll().find((event) =>
    ValidationEvents.artifact.published.is(event)
  );
  assert.ok(artifactEvent && ValidationEvents.artifact.published.is(artifactEvent));
  assert.equal(artifactEvent.payload.taskId, task.taskId);
  assert.equal(artifactEvent.payload.ref, artifactRef);
  await domainStage.stop();
});

test("RunStageExecutor releases the journal lock when startup fails after installing the RunScope", async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-run-start-failure-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const runId = "run-start-failure";
  const runRoot = join(fixtureRoot, "run", runId);
  const journal = RunJournal.create({ runId, runRoot });
  const executor = new RunStageExecutor({
    runId,
    logger: noopLogger(),
  });
  const scope = new RunScope({
    runId,
    repoRoot: fixtureRoot,
    logger: noopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: new ValidationDomain(),
    journal,
    manifestStore: new RunManifestStore(runRoot),
    terminate: (reason) => executor.terminate(reason),
  });
  const failingStage: RunStage = {
    id: "startup_failure",
    start: async () => {
      throw new Error("test startup failed");
    },
  };
  executor.registerSerial(
    new RunScopeStage(scope),
    new RunJournalWriterStage(),
    failingStage,
  );

  await assert.rejects(
    executor.startup(),
    /test startup failed/,
  );

  assert.equal(executor.snapshot().status, "failed");
  assert.throws(() => currentRunScope(), /No active Scout run scope/);
  assert.equal(existsSync(join(runRoot, ".run.lock")), false);
});

function buildPlannedResumePacket(
  input: Omit<Parameters<typeof buildResumePacket>[0], "resumeActions">,
): string {
  return buildResumePacket({
    ...input,
    resumeActions: planResumeActions(input),
  });
}

function scoutEvent<TPayload>(
  type: EventType<TPayload>,
  payload: TPayload,
  occurredAt = "2026-07-22T00:00:00.000Z",
): ScoutEvent<TPayload> {
  return {
    id: "test-event",
    key: type,
    payload,
    occurredAt,
  };
}

function journalEvents(...inputs: ScoutEvent[]): RunJournalEvent[] {
  const created = scoutEvent(RunEvents.run.created, {
    runId: "run-resume-test",
    repoRoot: "/repo",
    createdAt: "2026-07-22T00:00:00.000Z",
  });
  return [created, ...inputs].map((input, index) => ({
    id: `event-${index + 1}`,
    key: {
      scope: input.key.scope,
      group: input.key.group,
      name: input.key.name,
      ...(input.key.tag === undefined ? {} : { tag: input.key.tag }),
      routeKey: input.key.routeKey,
    },
    payload: structuredClone(input.payload),
    occurredAt: input.occurredAt,
    version: 1,
    seq: index + 1,
    recordedAt: "2026-07-22T00:00:00.000Z",
  }));
}

function taskState(input: Partial<AgentTaskState> = {}): AgentTaskState {
  return {
    type: "local_agent",
    taskId: "researcher-task-0001",
    taskSequence: 1,
    agentId: "researcher",
    role: ScoutAgentRoles.Researcher,
    description: "研究当前行为",
    initialPrompt: agent.turn.message("研究当前行为"),
    status: AgentTaskStatuses.Running,
    isBackgrounded: true,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    ...input,
  };
}

function workerHost(
  runTurn: (input: { prompt: string }) => Promise<ReturnType<typeof completedTurn>>,
) {
  const spec: AgentThreadSpec = {
    role: ScoutAgentRoles.Researcher,
    phases: [ScoutAgentPhases.Research],
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
  return {
    agentId: "researcher",
    role: ScoutAgentRoles.Researcher,
    spec,
    runTurn,
    deliverTaskOutcome: async () => undefined,
  };
}

function completedTurn(finalResponse: string) {
  return {
    turn: {
      invocationId: `invocation-${finalResponse}`,
      agentId: "researcher",
      role: ScoutAgentRoles.Researcher,
      threadId: "thread-new",
      turnId: `turn-${finalResponse}`,
      startedAt: "2026-07-22T00:00:00.000Z",
      finishedAt: "2026-07-22T00:00:01.000Z",
      status: "completed" as const,
    },
    finalResponse,
  };
}

function noopLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}
