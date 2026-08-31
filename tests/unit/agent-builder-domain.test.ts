import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBuilder } from "../../src/agent/builder/agent-builder.js";
import { AgentBackend } from "../../src/agent/backend/agent-backend.js";
import { AgentRegistry } from "../../src/agent/core/agent-registry.js";
import { AgentTaskStore } from "../../src/agent/task/agent-task-store.js";
import { CoordinatorAgent } from "../../src/agent/roles/coordinator-agent.js";
import type { ScoutAgentOptions } from "../../src/agent/core/scout-agent.js";
import {
  AGENT_ARCHIVE_TASK_TOOL_NAMESPACE,
  AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
  AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
  AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE,
  AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
  AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
  AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
} from "../../src/agent/tools/agent-tools.js";
import {
  scoutAgentPermissionProfile,
  type AgentThreadSnapshot,
  type ScoutAgentRole,
} from "../../src/agent/thread/types.js";
import type { AgentTurnCompletedEvent } from "../../src/agent/thread/turn-events.js";
import type { AgentDynamicToolSpec } from "../../src/agent/tools/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { createGraphState, Scheduler } from "../../src/core/workflow/index.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import type {
  DynamicToolCallHandler,
} from "../../src/agent-server/types.js";
import type {
  AppServerCollabAgentToolCallItem,
  AppServerResolvedTimelineEntry,
  AppServerThreadState,
  AppServerTimelineEntry,
} from "../../src/agent-server/codex/app-server-event-store.js";
import type {
  CodexAppServerClient,
  ThreadStartOptions,
} from "../../src/agent-server/codex/app-server-client.js";
import type { AssetCommit, CodexMount } from "../../src/asset-store/index.js";
import type { ScoutDomain } from "../../src/domain/index.js";
import type { ScoutDomainDynamicToolCall } from "../../src/domain/types.js";
import {
  buildRunContextBundle,
  type RunEnvironment,
} from "../../src/run/types.js";
import {
  installRunScope,
  RunScope,
} from "../../src/run/run-scope.js";
import type {
  AgentMessageReply,
  AgentMessageSend,
  RuntimeDisclosureEvent,
  RuntimeInteractionPort,
  RuntimeInteractionUnsubscribe,
  SubprocessProgressSnapshot,
} from "../../src/interaction/index.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/index.js";
import type {
  AgentActivity,
  AgentNativeSubagentActivity,
  AgentTurnActivity,
} from "../../src/agent/activity/activity-event.js";
import { InteractionGateway } from "../../src/interaction/index.js";
import { attachments } from "../../src/agent/context/index.js";
import { agent } from "../../src/agent/context/agent-attachments.js";
import { CoordinatorContextTags } from "../../src/agent/runner/coordinator/coordinator-attachments.js";
import type { AgentTaskNotAssignedEventPayload } from "../../src/agent/task/task-events.js";
import type { ScoutEvent } from "../../src/core/events/index.js";
import type { LogEvent, Logger } from "../../src/core/logging/index.js";
import { WorkerAgent } from "../../src/agent/roles/worker-agent.js";
import type { RunLifecycleSnapshot } from "../../src/run/lifecycle/index.js";
import { createTestScheduler } from "../helpers/run-persistence.js";
import {
  AgentTaskDispositionKinds,
  AgentTaskStatuses,
  type AgentTaskState,
} from "../../src/agent/task/types.js";
import {
  RunJournal,
  RunJournalWriter,
} from "../../src/run/journal/index.js";
import { RunEvents } from "../../src/run/events/index.js";
import { RunManifestStore } from "../../src/run/persistence/index.js";

let releaseTestRunScope: (() => void) | undefined;

afterEach(() => {
  const release = releaseTestRunScope;
  releaseTestRunScope = undefined;
  release?.();
});

test("AgentBuilder creates a coordinator with agent and single-domain tools", () => {
  const domainTool = buildDomainTool("domain-a");
  const fixture = createAgentFixture("builder-coordinator", {
    domain: createStaticDomain("domain-a", [domainTool]),
  });
  const builder = new AgentBuilder();

  const agent = builder.buildCoordinator();
  const tools = agent.spec.dynamicTools ?? [];

  assert.ok(agent instanceof CoordinatorAgent);
  assert.equal(agent.stepRunner.agentId, agent.agentId);
  assert.deepEqual(agent.spec.model, {
    id: "gpt-5.5",
    provider: "GuruOpenAI",
    reasoningEffort: "high",
    reasoningSummary: "concise",
  });
  assert.deepEqual(agent.spec.config, {
    web_search: "disabled",
    features: {
      shell_tool: true,
      multi_agent: false,
      apps: false,
    },
    agents: {
      max_threads: 6,
      max_depth: 1,
    },
  });
  assert.equal(fixture.registry.listAgents()[0], agent);
  assert.ok(tools.some((tool) => tool.namespace === AGENT_ASSIGN_TASK_TOOL_NAMESPACE && tool.name === "AssignTask"));
  assert.ok(tools.some((tool) => tool.namespace === AGENT_SEND_MESSAGE_TOOL_NAMESPACE && tool.name === "SendMessage"));
  assert.ok(tools.some((tool) => tool.namespace === AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE && tool.name === "RespondHumanInput"));
  assert.ok(tools.some((tool) => tool.namespace === AGENT_ARCHIVE_TASK_TOOL_NAMESPACE && tool.name === "ArchiveTask"));
  assert.ok(tools.some((tool) =>
    tool.namespace === AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE
    && tool.name === "SubmitPhaseOutcome"
  ));
  assert.equal(tools.some((tool) => tool.name === "SubmitTask"), false);
  assert.equal(tools.some((tool) => tool.name === "RequestHumanInput"), false);
  assert.ok(tools.some((tool) => tool.namespace === "domain-a" && tool.name === "DomainProbe"));
  assert.equal(tools.some((tool) => tool.namespace === "domain-b"), false);
  const instructions = agent.spec.developerInstructions ?? "";
  assert.match(instructions, /common instructions/);
  assert.doesNotMatch(instructions, /worker instructions/);
  assert.doesNotMatch(instructions, /coordinator instructions/);
  assert.equal(instructions.match(/common instructions/g)?.length, 1);
});

test("AgentBuilder rejects a dynamic tool whose guidance Skill is not mounted", () => {
  const fixture = createAgentFixture("builder-missing-tool-guidance", {
    domain: createStaticDomain("domain-empty", []),
  });
  fixture.mount.skills = fixture.mount.skills.filter((skill) =>
    skill.name !== "tool-scout-assign-task"
  );

  assert.throws(
    () => new AgentBuilder().buildCoordinator(),
    /Dynamic tool AssignTask requires unavailable guidance Skill tool-scout-assign-task/,
  );
});

test("AgentBuilder creates one worker role while preserving domain tool scope", () => {
  const fixture = createAgentFixture("builder-worker", {
    domain: createStaticDomain("domain-worker", [buildDomainTool("domain-worker")]),
  });
  const researcherMount = createMount(fixture.root, "researcher");
  const researcherCommit = createAssetCommit(researcherMount);
  prepareAgent(fixture, "researcher", researcherMount, researcherCommit);
  const builder = new AgentBuilder();

  const agent = builder.buildWorker("researcher");
  const tools = agent.spec.dynamicTools ?? [];

  assert.ok(agent instanceof WorkerAgent);
  assert.equal(agent.taskRunner, undefined);
  assert.deepEqual(agent.spec.config, {
    features: {
      multi_agent: true,
    },
    agents: {
      max_threads: 6,
      max_depth: 1,
    },
  });
  assert.equal(fixture.registry.resolveAgent("researcher"), agent);
  assert.ok(tools.some((tool) => tool.namespace === AGENT_SEND_MESSAGE_TOOL_NAMESPACE && tool.name === "SendMessage"));
  assert.ok(tools.some((tool) => tool.namespace === AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE && tool.name === "RequestHumanInput"));
  assert.ok(tools.some((tool) => tool.namespace === AGENT_SUBMIT_TASK_TOOL_NAMESPACE && tool.name === "SubmitTask"));
  assert.deepEqual(tools.filter((tool) => tool.namespace !== "domain-worker").map((tool) => tool.name), [
    "SendMessage",
    "RequestHumanInput",
    "SubmitTask",
  ]);
  assert.equal(tools.some((tool) => tool.name === "AssignTask"), false);
  assert.equal(tools.some((tool) => tool.name === "ArchiveTask"), false);
  assert.equal(tools.some((tool) => tool.name === "RespondHumanInput"), false);
  assert.ok(tools.some((tool) => tool.namespace === "domain-worker" && tool.name === "DomainProbe"));
  const instructions = agent.spec.developerInstructions ?? "";
  assert.match(instructions, /common instructions/);
  assert.match(instructions, /worker instructions/);
  assert.doesNotMatch(instructions, /researcher instructions/);
  assert.equal(instructions.match(/common instructions/g)?.length, 1);
  assert.ok(instructions.indexOf("common instructions") < instructions.indexOf("worker instructions"));
});

test("AgentBuilder creates an arbitrary Workflow role as a generic Worker", () => {
  const scheduler = new Scheduler(createGraphState({
    workflowProfile: "dynamic-role-test",
    phases: [{
      name: "audit",
      edges: { completed: null, error: null },
      roles: ["auditor"],
    }],
    roles: [
      { name: "coordinator", phases: ["Synthesis"] },
      { name: "auditor", phases: ["audit"] },
    ],
    currentPhase: "audit",
  }), new InMemoryEventBus());
  const fixture = createAgentFixture("builder-dynamic-worker", { scheduler });
  const auditorMount = createMount(fixture.root, "auditor");
  auditorMount.agentProfile.phases = ["audit"];
  prepareAgent(fixture, "auditor", auditorMount, createAssetCommit(auditorMount));

  const auditor = new AgentBuilder().buildWorker("auditor");
  const coordinator = new AgentBuilder().buildCoordinator();
  const assignTask = coordinator.spec.dynamicTools?.find((tool) => tool.name === "AssignTask");
  const assignTaskSchema = assignTask?.inputSchema as {
    properties?: Record<string, unknown>;
  } | undefined;

  assert.ok(auditor instanceof WorkerAgent);
  assert.equal(auditor.role, "auditor");
  assert.deepEqual(auditor.phases, ["audit"]);
  assert.equal(auditor.spec.permissionProfile, "scout-auditor");
  assert.deepEqual(Object.keys(assignTaskSchema?.properties ?? {}), ["description", "prompt"]);
});

test("Workflow Worker turns use the role permission profile", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("builder-validator-write-roots", { appServer });
  const validatorMount = createMount(fixture.root, "validator");
  const validatorCommit = createAssetCommit(validatorMount);
  prepareAgent(fixture, "validator", validatorMount, validatorCommit);
  const validator = new AgentBuilder().buildWorker("validator");

  assert.ok(validator instanceof WorkerAgent);
  assert.equal(validator.spec.permissionProfile, scoutAgentPermissionProfile("validator"));
  await validator.startThread();
  assert.deepEqual(validator.threadSnapshot?.startInput.config, {
    features: {
      multi_agent: true,
    },
    agents: {
      max_threads: 6,
      max_depth: 1,
    },
    model_reasoning_effort: "high",
  });
  await validator.runTurn({ prompt: "Write the Research Pack Gate." });

  assert.equal(
    appServer.turnInputs[0]?.permissions,
    scoutAgentPermissionProfile("validator"),
  );
});

test("Worker turns select one stable profile independently of write-root order", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("builder-worker-write-root-order", { appServer });
  const researcherMount = createMount(fixture.root, "researcher");
  const codebaseRoot = join(fixture.root, "managed-codebase");
  researcherMount.writableRoots = [
    researcherMount.mountRoot,
    researcherMount.artifactRoot,
    codebaseRoot,
  ];
  prepareAgent(
    fixture,
    "researcher",
    researcherMount,
    createAssetCommit(researcherMount),
  );
  const researcher = new AgentBuilder().buildWorker("researcher");

  await researcher.startThread();
  await researcher.runTurn({ prompt: "Inspect the Research inputs." });

  assert.equal(
    appServer.turnInputs[0]?.permissions,
    scoutAgentPermissionProfile("researcher"),
  );
});

for (const status of ["failed", "interrupted"] as const) {
  test(`ScoutAgent preserves ${status} app-server turn status`, async () => {
    const appServer = createFakeAppServer({
      turnStatus: status,
      turnError: `${status} by app-server`,
    });
    const fixture = createAgentFixture(`turn-status-${status}`, { appServer });
    const researcherMount = createMount(fixture.root, "researcher");
    prepareAgent(
      fixture,
      "researcher",
      researcherMount,
      createAssetCommit(researcherMount),
    );
    const researcher = new AgentBuilder().buildWorker("researcher");

    await researcher.startThread();
    const outcome = await researcher.runTurn({ prompt: `Return ${status}.` });

    assert.equal(outcome.turn.status, status);
    assert.equal(outcome.turn.error, `${status} by app-server`);
  });
}

test("ScoutAgent omits a null app-server turn error", async () => {
  const appServer = createFakeAppServer({
    turnStatus: "interrupted",
    turnError: null,
  });
  const fixture = createAgentFixture("turn-null-error", { appServer });
  const researcherMount = createMount(fixture.root, "researcher");
  prepareAgent(
    fixture,
    "researcher",
    researcherMount,
    createAssetCommit(researcherMount),
  );
  const researcher = new AgentBuilder().buildWorker("researcher");

  await researcher.startThread();
  const outcome = await researcher.runTurn({ prompt: "Return interrupted." });

  assert.equal(outcome.turn.status, "interrupted");
  assert.equal(outcome.turn.error, undefined);
});

test("WorkerAgent keeps its bound TaskRunner and reports a rejected task assignment", async () => {
  const appServer = createFakeAppServer();
  const domain = createStaticDomain("domain-task-not-assigned", []);
  const fixture = createAgentFixture("worker-task-not-assigned", { appServer, domain });
  const researcherMount = createMount(fixture.root, "researcher");
  const researcherCommit = createAssetCommit(researcherMount);
  prepareAgent(fixture, "researcher", researcherMount, researcherCommit);
  const builder = new AgentBuilder();
  const coordinatorAgent = builder.buildCoordinator();
  await coordinatorAgent.startThread();
  const worker = builder.buildWorker("researcher") as WorkerAgent;
  new AgentBackend().start();
  const firstAssignment = await worker.assignTask({
    taskId: "researcher-task-0001",
    description: "Research the first BDD",
    phase: "research",
    prompt: agent.turn.message("Research the first BDD."),
    isBackgrounded: true,
  });
  assert.equal(firstAssignment.ok, true);
  if (!firstAssignment.ok) throw new Error("Expected the first task to be assigned.");
  const boundRunner = worker.taskRunner;
  assert.ok(boundRunner);
  const reusableStepRunner = worker.stepRunner;

  assert.ok(appServer.handler);
  const secondAssignmentPromise = appServer.handler({
    threadId: coordinatorAgent.threadId ?? "",
    turnId: "turn-task-not-assigned",
    callId: "call-task-not-assigned",
    namespace: AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
    tool: "AssignTask",
    arguments: {
      description: "Research another BDD",
      prompt: "Research another BDD.",
    },
  });
  await worker.stopTask(firstAssignment.value.taskId, "test_cleanup");
  const secondAssignment = await secondAssignmentPromise;
  const rejectionReason = "Workflow Phase research has no available Worker.";

  assert.equal(secondAssignment.success, true);
  assert.deepEqual(JSON.parse(secondAssignment.contentItems[0]?.text ?? "{}"), {
    status: "not_assigned",
    reason: rejectionReason,
  });
  assert.equal(worker.taskRunner, boundRunner);
  assert.equal(fixture.taskStore.listTasks().length, 1);
  await worker.archiveTask(firstAssignment.value.taskId);
  const assignmentAfterArchive = await worker.assignTask({
    description: "Research another BDD after archive",
    phase: "research",
    prompt: agent.turn.message("Research another BDD after archive."),
    isBackgrounded: true,
  });
  assert.equal(assignmentAfterArchive.ok, true);
  if (!assignmentAfterArchive.ok) throw new Error("Expected assignment after archive to succeed.");
  assert.notEqual(worker.taskRunner, boundRunner);
  assert.equal(worker.stepRunner, reusableStepRunner);
  await worker.stopTask(assignmentAfterArchive.value.taskId, "test_cleanup");
  await worker.archiveTask(assignmentAfterArchive.value.taskId);
  await coordinatorAgent.stopAgent("test_cleanup");
});

test("AssignTask routes through the current Phase and skips a busy first role", async () => {
  const appServer = createFakeAppServer();
  const scheduler = new Scheduler(createGraphState({
    workflowProfile: "phase-routing-test",
    phases: [{
      name: "audit",
      edges: { completed: null, error: null },
      roles: ["auditor-a", "auditor-b"],
    }],
    roles: [
      { name: "coordinator", phases: ["Synthesis"] },
      { name: "auditor-a", phases: ["audit"] },
      { name: "auditor-b", phases: ["audit"] },
    ],
    currentPhase: "audit",
  }), new InMemoryEventBus());
  const fixture = createAgentFixture("assign-task-phase-routing", {
    appServer,
    scheduler,
  });
  const firstMount = createMount(fixture.root, "auditor-a");
  const secondMount = createMount(fixture.root, "auditor-b");
  firstMount.agentProfile.phases = ["audit"];
  secondMount.agentProfile.phases = ["audit"];
  prepareAgent(fixture, "auditor-a", firstMount, createAssetCommit(firstMount));
  prepareAgent(fixture, "auditor-b", secondMount, createAssetCommit(secondMount));
  const builder = new AgentBuilder();
  const coordinatorAgent = builder.buildCoordinator();
  const firstWorker = builder.buildWorker("auditor-a") as WorkerAgent;
  const secondWorker = builder.buildWorker("auditor-b") as WorkerAgent;
  const now = new Date().toISOString();
  firstWorker.restoreTask({
    task: {
      type: "local_agent",
      taskId: "auditor-a-task-0001",
      taskSequence: 1,
      agentId: "auditor-a",
      role: "auditor-a",
      phase: "audit",
      description: "Existing audit",
      initialPrompt: agent.turn.message("Continue the existing audit."),
      status: AgentTaskStatuses.Queued,
      isBackgrounded: true,
      stepIds: [],
      dispositions: [],
      createdAt: now,
      updatedAt: now,
    },
    maxTaskSequence: 1,
  });
  await coordinatorAgent.startThread();
  const backend = new AgentBackend();
  backend.start();

  assert.ok(appServer.handler);
  const result = await appServer.handler({
    threadId: coordinatorAgent.threadId ?? "",
    turnId: "turn-assign-audit",
    callId: "call-assign-audit",
    namespace: AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
    tool: "AssignTask",
    arguments: {
      description: "Run the next audit",
      prompt: "Inspect the declared audit evidence.",
    },
  });
  const response = JSON.parse(result.contentItems[0]?.text ?? "{}") as {
    status?: string;
    taskId?: string;
  };
  const assignedTask = response.taskId
    ? fixture.taskStore.getTask(response.taskId)
    : undefined;

  assert.equal(result.success, true);
  assert.equal(response.status, "assigned");
  assert.equal(assignedTask?.agentId, "auditor-b");
  assert.equal(assignedTask?.phase, "audit");
  assert.equal(firstWorker.taskRunner?.snapshot().activeTask?.taskId, "auditor-a-task-0001");

  if (assignedTask) await secondWorker.archiveTask(assignedTask.taskId);
  await firstWorker.archiveTask("auditor-a-task-0001");
  await coordinatorAgent.stopAgent("test_cleanup");
  backend.stop();
});

test("SubmitPhaseOutcome advances the cursor and schedules one fresh Coordinator Step", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("submit-phase-outcome", { appServer });
  const coordinatorAgent = new AgentBuilder().buildCoordinator();
  await coordinatorAgent.startThread();
  const backend = new AgentBackend();
  backend.start();

  assert.ok(appServer.handler);
  const first = await appServer.handler({
    threadId: coordinatorAgent.threadId ?? "",
    turnId: "turn-submit-phase-research",
    callId: "call-submit-phase-research",
    namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
    tool: "SubmitPhaseOutcome",
    arguments: { outcome: "completed" },
  });
  await coordinatorAgent.runToIdle();
  const second = await appServer.handler({
    threadId: coordinatorAgent.threadId ?? "",
    turnId: "turn-submit-phase-review",
    callId: "call-submit-phase-review",
    namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
    tool: "SubmitPhaseOutcome",
    arguments: { outcome: "completed" },
  });
  await coordinatorAgent.runToIdle();

  assert.deepEqual(JSON.parse(first.contentItems[0]?.text ?? "{}"), {
    status: "accepted",
    currentPhase: "research-reviewer",
    cycleCompleted: false,
  });
  assert.deepEqual(JSON.parse(second.contentItems[0]?.text ?? "{}"), {
    status: "accepted",
    currentPhase: "verify",
    cycleCompleted: false,
  });
  assert.equal(appServer.turnInputs.length, 2);
  assert.match(
    appServer.turnInputs[0]?.prompt ?? "",
    /<workflow_phase>\ncurrent_phase: research-reviewer\n<\/workflow_phase>/,
  );
  assert.match(
    appServer.turnInputs[1]?.prompt ?? "",
    /<workflow_phase>\ncurrent_phase: verify\n<\/workflow_phase>/,
  );
  for (const input of appServer.turnInputs) {
    assert.equal(input.prompt?.match(/<workflow_phase>/g)?.length, 1);
  }

  await coordinatorAgent.stopAgent("test_cleanup");
  backend.stop();
});

test("A terminal Phase outcome resets the cursor without scheduling a Coordinator Step", async () => {
  const appServer = createFakeAppServer();
  const scheduler = new Scheduler(createGraphState({
    workflowProfile: "terminal-phase-test",
    phases: [{
      name: "audit",
      edges: { completed: null, error: null },
      roles: ["auditor"],
    }],
    roles: [
      { name: "coordinator", phases: ["Synthesis"] },
      { name: "auditor", phases: ["audit"] },
    ],
    currentPhase: "audit",
  }), new InMemoryEventBus());
  createAgentFixture("submit-terminal-phase-outcome", { appServer, scheduler });
  const coordinatorAgent = new AgentBuilder().buildCoordinator();
  await coordinatorAgent.startThread();
  const backend = new AgentBackend();
  backend.start();

  assert.ok(appServer.handler);
  const result = await appServer.handler({
    threadId: coordinatorAgent.threadId ?? "",
    turnId: "turn-submit-terminal-phase",
    callId: "call-submit-terminal-phase",
    namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
    tool: "SubmitPhaseOutcome",
    arguments: { outcome: "completed" },
  });
  await coordinatorAgent.runToIdle();

  assert.deepEqual(JSON.parse(result.contentItems[0]?.text ?? "{}"), {
    status: "accepted",
    currentPhase: "audit",
    cycleCompleted: true,
  });
  assert.equal(scheduler.snapshot().currentPhase, "audit");
  assert.equal(appServer.turnInputs.length, 0);

  await coordinatorAgent.stopAgent("test_cleanup");
  backend.stop();
});

test("WorkerAgent keeps restored failed and stopped tasks bound until archive", async () => {
  const fixture = createAgentFixture("worker-restored-terminal-task");
  const researcherMount = createMount(fixture.root, "researcher");
  prepareAgent(
    fixture,
    "researcher",
    researcherMount,
    createAssetCommit(researcherMount),
  );
  const worker = new AgentBuilder().buildWorker("researcher") as WorkerAgent;

  for (const [index, status] of [
    AgentTaskStatuses.Failed,
    AgentTaskStatuses.Stopped,
  ].entries()) {
    const taskSequence = index + 1;
    const now = new Date().toISOString();
    const task = {
      type: "local_agent",
      taskId: `researcher-task-${String(taskSequence).padStart(4, "0")}`,
      taskSequence,
      agentId: worker.agentId,
      role: "researcher",
      phase: "research",
      description: "恢复未归档终态任务",
      initialPrompt: agent.turn.message("恢复未归档终态任务。"),
      status,
      isBackgrounded: true,
      stepIds: [],
      dispositions: [],
      createdAt: now,
      updatedAt: now,
      finishedAt: now,
      error: "terminal state",
    } satisfies AgentTaskState;
    worker.restoreTask({ task, maxTaskSequence: taskSequence });

    const assignment = await worker.assignTask({
      description: "不应接受的新任务",
      phase: "research",
      prompt: agent.turn.message("不应接受的新任务。"),
    });

    assert.equal(assignment.ok, false);
    if (assignment.ok) throw new Error("Expected restored terminal task to reject assignment.");
    assert.equal(assignment.error.activeTaskId, task.taskId);
    assert.equal(worker.taskRunner?.snapshot().activeTask?.status, status);
    await worker.archiveTask(task.taskId);
  }
});

test("AgentRegistry indexes registered agents and thread bindings without owning thread startup", () => {
  const fixture = createAgentFixture("registry-bind");
  const builder = new AgentBuilder();
  const agent = builder.buildCoordinator();

  fixture.registry.bindThread(agent.agentId, "thread-coordinator");

  assert.equal(fixture.registry.resolveAgent(agent.agentId), agent);
  assert.equal(fixture.registry.resolveAgent("thread-coordinator"), agent);
  assert.equal(fixture.registry.resolveToolCaller("thread-coordinator"), agent);
  assert.equal(fixture.registry.listAgents().length, 1);
});

test("ScoutAgent starts a thread, runs preflight, and binds it to registry", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("thread-start", { appServer });
  const builder = new AgentBuilder();
  const agent = builder.buildCoordinator();
  const threadEvents: Array<ScoutEvent<AgentThreadSnapshot>> = [];
  const unsubscribe = fixture.eventBus.subscribe<AgentThreadSnapshot>(
    AgentEvents.thread,
    (event) => {
      threadEvents.push(event);
    },
  );

  const thread = await agent.startThread();

  assert.equal(thread.threadId, "thread-test");
  assert.equal(thread.agentId, "coordinator");
  assert.equal(thread.role, "coordinator");
  assert.equal(thread.status, "active");
  assert.deepEqual(thread.startResponse, { thread: { id: "thread-test" } });
  assert.deepEqual({
    model: appServer.threadInputs[0]?.model,
    modelProvider: appServer.threadInputs[0]?.modelProvider,
    reasoningEffort: appServer.threadInputs[0]?.reasoningEffort,
  }, {
    model: "gpt-5.5",
    modelProvider: "GuruOpenAI",
    reasoningEffort: "high",
  });
  assert.equal(fixture.registry.resolveAgentByThreadId("thread-test"), agent);
  await waitFor(() => agent.threadPreflightSnapshot?.result.status === "passed");
  assert.equal(agent.threadPreflightSnapshot?.threadId, "thread-test");

  await agent.runTurn({ prompt: "check model profile" });
  assert.deepEqual({
    prompt: appServer.turnInputs[0]?.prompt,
    model: appServer.turnInputs[0]?.model,
    reasoningEffort: appServer.turnInputs[0]?.reasoningEffort,
    reasoningSummary: appServer.turnInputs[0]?.reasoningSummary,
  }, {
    prompt: "check model profile",
    model: "gpt-5.5",
    reasoningEffort: "high",
    reasoningSummary: "concise",
  });

  await agent.stopAgent("test_complete");
  assert.equal(agent.threadSnapshot?.status, "closed");
  assert.equal(agent.threadSnapshot?.closeReason, "test_complete");
  assert.ok(agent.threadSnapshot?.closedAt);
  await waitFor(() => threadEvents.length === 2);
  assert.deepEqual(threadEvents.map((event) => event.key.routeKey), [
    AgentEvents.thread.started.routeKey,
    AgentEvents.thread.closed.routeKey,
  ]);
  assert.equal(threadEvents[0]?.payload.startInput.developerInstructions, agent.spec.developerInstructions);
  assert.equal(threadEvents[1]?.payload.status, "closed");
  await assert.rejects(agent.startThread(), /thread is closed/);
  unsubscribe();
});

test("ScoutAgent restarts a journaled thread as a distinct lifecycle fact", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("thread-restart", { appServer });
  const agent = new AgentBuilder().buildCoordinator();
  const threadEvents: ScoutEvent[] = [];
  const unsubscribe = fixture.eventBus.subscribe(
    AgentEvents.thread,
    (event) => {
      threadEvents.push(event);
    },
  );
  const previousThread = {
    agentId: agent.agentId,
    role: agent.role,
    phases: [...agent.phases],
    contextBundleId: agent.spec.contextBundleId,
    threadId: "thread-before-restart",
    createdAt: "2026-08-10T00:00:00.000Z",
    status: "closed",
    closedAt: "2026-08-10T00:01:00.000Z",
    closeReason: "runtime_detached",
    startInput: {
      cwd: agent.spec.cwd,
      runtimeWorkspaceRoots: [agent.spec.cwd],
      approvalPolicy: agent.spec.approvalPolicy,
      permissions: agent.spec.permissionProfile,
      ephemeral: false,
    },
    startResponse: { thread: { id: "thread-before-restart" } },
  } satisfies AgentThreadSnapshot;

  const thread = await agent.restartThread({
    previousThread,
    reason: "codex_rollout_not_persisted",
  });

  assert.equal(thread.threadId, "thread-test");
  assert.equal(fixture.registry.resolveAgentByThreadId("thread-test"), agent);
  await waitFor(() => agent.threadPreflightSnapshot?.result.status === "passed");
  assert.equal(threadEvents.length, 1);
  const restarted = threadEvents[0];
  assert.ok(restarted && AgentEvents.thread.restarted.is(restarted));
  assert.equal(restarted.payload.previousThreadId, previousThread.threadId);
  assert.equal(restarted.payload.reason, "codex_rollout_not_persisted");
  assert.equal(restarted.payload.newThread.threadId, thread.threadId);
  assert.equal(restarted.occurredAt, restarted.payload.restartedAt);
  unsubscribe();
});

test("ScoutAgent interrupts its owned turn and seals queued work before stopping", async () => {
  let releaseTurn: (() => void) | undefined;
  let markTurnStarted: (() => void) | undefined;
  const turnReleased = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const turnStarted = new Promise<void>((resolve) => {
    markTurnStarted = resolve;
  });
  const appServer = createFakeAppServer({
    turnStatus: "interrupted",
    onRunTurn: async () => {
      markTurnStarted?.();
      await turnReleased;
    },
    onInterruptTurn: () => releaseTurn?.(),
  });
  createAgentFixture("stop-active-turn", { appServer });
  const coordinator = new AgentBuilder().buildCoordinator();
  await coordinator.startThread();
  await coordinator.sendMessage({ message: agent.turn.message("first turn") });
  await turnStarted;
  await coordinator.sendMessage({ message: agent.turn.message("must not start") });

  await coordinator.stopAgent("test_complete");

  assert.deepEqual(appServer.interruptInputs, [{
    threadId: "thread-test",
    turnId: "turn-test",
  }]);
  assert.equal(appServer.turnInputs.length, 1);
  assert.equal(coordinator.threadSnapshot?.status, "closed");
});

test("ScoutAgent cancels its turn waiter and reports an interrupt failure", async () => {
  let rejectTurn: ((error: Error) => void) | undefined;
  let markTurnStarted: (() => void) | undefined;
  const turnStarted = new Promise<void>((resolve) => {
    markTurnStarted = resolve;
  });
  const turnResult = new Promise<never>((_resolve, reject) => {
    rejectTurn = reject;
  });
  const appServer = createFakeAppServer({
    onRunTurn: async () => {
      markTurnStarted?.();
      return turnResult;
    },
    onInterruptTurn: () => {
      throw new Error("interrupt transport failed");
    },
    onCancelTurnWait: (_threadId, error) => {
      rejectTurn?.(error);
    },
  });
  const fixture = createAgentFixture("stop-interrupt-failure", { appServer });
  const turns: AgentTurnCompletedEvent["turn"][] = [];
  fixture.eventBus.subscribe<AgentTurnCompletedEvent>(AgentEvents.turn.completed, (event) => {
    turns.push(event.payload.turn);
  });
  const coordinator = new AgentBuilder().buildCoordinator();
  await coordinator.startThread();
  await coordinator.sendMessage({ message: agent.turn.message("blocked turn") });
  await turnStarted;

  await assert.rejects(
    coordinator.stopAgent("test_complete"),
    /interrupt transport failed/,
  );

  assert.deepEqual(appServer.cancelTurnWaitInputs, [{
    threadId: "thread-test",
    error: "interrupt transport failed",
  }]);
  await waitFor(() => turns.length === 1);
  assert.equal(turns[0]?.status, "interrupted");
  assert.equal(turns[0]?.turnId, "turn-test");
  assert.equal(coordinator.threadSnapshot?.status, "closed");
});

test("ScoutAgent interrupts a turn that binds after the stop timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let releaseTurnStart: (() => void) | undefined;
  let markTurnStartPending: (() => void) | undefined;
  const turnStartReleased = new Promise<void>((resolve) => {
    releaseTurnStart = resolve;
  });
  const turnStartPending = new Promise<void>((resolve) => {
    markTurnStartPending = resolve;
  });
  const appServer = createFakeAppServer({
    turnStatus: "interrupted",
    onBeforeTurnStarted: async () => {
      markTurnStartPending?.();
      await turnStartReleased;
    },
    onCancelTurnWait: () => releaseTurnStart?.(),
  });
  createAgentFixture("stop-late-turn-start", { appServer });
  const coordinator = new AgentBuilder().buildCoordinator();
  await coordinator.startThread();
  await coordinator.sendMessage({ message: agent.turn.message("blocked turn") });
  await turnStartPending;
  await coordinator.sendMessage({ message: agent.turn.message("must not start") });

  const stopped = coordinator.stopAgent("test_complete");
  t.mock.timers.tick(5_000);

  await assert.rejects(stopped, /Timed out interrupting the active turn/);
  assert.deepEqual(appServer.interruptInputs, [{
    threadId: "thread-test",
    turnId: "turn-test",
  }]);
  assert.equal(appServer.turnInputs.length, 1);
  assert.equal(coordinator.threadSnapshot?.status, "closed");
});

test("ScoutAgent returns no goal when setting a goal fails", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("goal-failure", { appServer });
  const coordinator = new CoordinatorAgent(fixture.options);
  fixture.registry.registerAgent(coordinator);
  await coordinator.startThread();

  const goal = await coordinator.setThreadGoal({
    objective: "g".repeat(1000),
  });

  assert.equal(goal, undefined);
  await coordinator.stopAgent("test_cleanup");
});

test("AgentBackend does not publish app-server agent message deltas as activity", () => {
  const appServer = createFakeAppServer();
  const domain = createStaticDomain("domain-skip-agent-message-delta", []);
  const fixture = createAgentFixture("skip-agent-message-delta", { appServer, domain });
  const activities: AgentActivity[] = [];
  fixture.eventBus.subscribe<AgentActivity>(AgentEvents.activity.observed, (event) => {
    activities.push(event.payload);
  });
  const registry = fixture.registry;
  new AgentBackend().start();
  const coordinator = new CoordinatorAgent(fixture.options);
  registry.registerAgent(coordinator);
  registry.bindThread(coordinator.agentId, "thread-coordinator");

  const entry = {
    seq: 1,
    stream: "item",
    kind: "agent_message_delta",
    receivedAt: "2026-07-04T00:00:00.000Z",
    threadId: "thread-coordinator",
    turnId: "turn-1",
  } satisfies AppServerTimelineEntry;
  appServer.emitTimeline(entry);

  assert.deepEqual(activities, []);
});

test("AgentBackend normalizes app-server items into Agent activity", () => {
  const entry = {
    seq: 7,
    stream: "item",
    kind: "item_completed",
    receivedAt: "2026-07-14T00:00:00.000Z",
    threadId: "thread-coordinator",
    turnId: "turn-1",
    itemId: "reasoning-1",
  } satisfies AppServerTimelineEntry;
  let resolveCount = 0;
  const appServer = createFakeAppServer({
    resolveTimelineEntry: (resolvedEntry) => {
      resolveCount += 1;
      return {
        entry: resolvedEntry,
        item: {
          id: "reasoning-1",
          type: "reasoning",
          status: "completed",
          summary: ["Inspect current evidence."],
          content: ["private chain of thought"],
        },
      };
    },
  });
  const fixture = createAgentFixture("agent-activity", {
    appServer,
    domain: createStaticDomain("domain-agent-activity", []),
  });
  const coordinator = new CoordinatorAgent(fixture.options);
  fixture.registry.registerAgent(coordinator);
  fixture.registry.bindThread(coordinator.agentId, entry.threadId);
  const activities: AgentActivity[] = [];
  fixture.eventBus.subscribe<AgentActivity>(AgentEvents.activity.observed, (event) => {
    activities.push(event.payload);
  });
  new AgentBackend().start();

  appServer.emitTimeline(entry);

  assert.equal(resolveCount, 1);
  assert.deepEqual(activities, [{
    seq: 7,
    agentId: "coordinator",
    role: "coordinator",
    taskId: undefined,
    threadId: "thread-coordinator",
    turnId: "turn-1",
    itemId: "reasoning-1",
    type: "reasoning",
    status: "completed",
    label: "Reasoning",
    detail: "Inspect current evidence.",
    updatedAt: "2026-07-14T00:00:00.000Z",
  }]);
  assert.equal(JSON.stringify(activities).includes("private chain of thought"), false);
});

test("AgentBackend publishes context compaction as ordinary activity", () => {
  const entries = [
    {
      seq: 7,
      stream: "item",
      kind: "item_started",
      receivedAt: "2026-07-14T00:00:00.000Z",
      threadId: "thread-coordinator",
      turnId: "turn-1",
      itemId: "compaction-1",
    },
    {
      seq: 8,
      stream: "item",
      kind: "item_completed",
      receivedAt: "2026-07-14T00:00:01.000Z",
      threadId: "thread-coordinator",
      turnId: "turn-1",
      itemId: "compaction-1",
    },
  ] satisfies AppServerTimelineEntry[];
  const appServer = createFakeAppServer({
    resolveTimelineEntry: (entry) => ({
      entry,
      item: {
        id: "compaction-1",
        type: "contextCompaction",
        status: entry.kind === "item_started" ? "inProgress" : "completed",
      },
    }),
  });
  const fixture = createAgentFixture("context-compaction-activity", {
    appServer,
    domain: createStaticDomain("domain-context-compaction-activity", []),
  });
  const coordinator = new CoordinatorAgent(fixture.options);
  fixture.registry.registerAgent(coordinator);
  fixture.registry.bindThread(coordinator.agentId, entries[0]!.threadId);
  const activities: AgentActivity[] = [];
  fixture.eventBus.subscribe<AgentActivity>(AgentEvents.activity.observed, (event) => {
    activities.push(event.payload);
  });
  new AgentBackend().start();

  for (const entry of entries) appServer.emitTimeline(entry);

  assert.deepEqual(
    activities.map((activity) => [
      activity.type,
      activity.label,
      activity.status,
      activity.updatedAt,
    ]),
    [
      ["contextCompaction", "Context compaction", "inProgress", entries[0]!.receivedAt],
      ["contextCompaction", "Context compaction", "completed", entries[1]!.receivedAt],
    ],
  );
});

test("AgentBackend publishes native subagent audit facts and concise activity", () => {
  const entry = {
    seq: 8,
    stream: "item",
    kind: "item_completed",
    receivedAt: "2026-07-21T00:00:00.000Z",
    threadId: "thread-researcher",
    turnId: "turn-1",
    itemId: "collab-1",
  } satisfies AppServerTimelineEntry;
  const item = {
    id: "collab-1",
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
  } satisfies AppServerCollabAgentToolCallItem;
  const appServer = createFakeAppServer({
    resolveTimelineEntry: () => ({
      entry,
      item,
      progressItem: {
        itemId: item.id,
        threadId: entry.threadId,
        turnId: entry.turnId,
        type: item.type,
        status: item.status,
        label: "Native subagent spawnAgent",
        detail: "thread-child-1",
        item,
        updatedAt: entry.receivedAt,
      },
    }),
  });
  const fixture = createAgentFixture("native-subagent-activity", {
    appServer,
    domain: createStaticDomain("domain-native-subagent-activity", []),
  });
  const researcherMount = createMount(fixture.root, "researcher");
  prepareAgent(fixture, "researcher", researcherMount, createAssetCommit(researcherMount));
  const researcher = new AgentBuilder().buildWorker("researcher");
  fixture.registry.bindThread(researcher.agentId, entry.threadId);
  const activities: AgentActivity[] = [];
  const nativeSubagentActivities: AgentNativeSubagentActivity[] = [];
  fixture.eventBus.subscribe<AgentActivity>(AgentEvents.activity.observed, (event) => {
    activities.push(event.payload);
  });
  fixture.eventBus.subscribe<AgentNativeSubagentActivity>(
    AgentEvents.activity.nativeSubagentObserved,
    (event) => {
      nativeSubagentActivities.push(event.payload);
    },
  );
  new AgentBackend().start();

  appServer.emitTimeline(entry);

  assert.deepEqual(nativeSubagentActivities, [{
    seq: 8,
    agentId: "researcher",
    role: "researcher",
    taskId: undefined,
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
  }]);
  assert.equal(activities.length, 1);
  assert.equal(activities[0]?.label, "Native subagent spawnAgent");
  assert.equal(activities[0]?.detail, "thread-child-1");
  assert.equal(JSON.stringify(activities).includes("检查一个边界明确的只读子任务"), false);
});

test("AgentBackend publishes turn lifecycle separately from item activity", () => {
  const started = {
    seq: 8,
    stream: "lifecycle",
    kind: "turn_started",
    receivedAt: "2026-07-14T00:00:01.000Z",
    threadId: "thread-coordinator",
    turnId: "turn-2",
  } satisfies AppServerTimelineEntry;
  const completed = {
    ...started,
    seq: 9,
    kind: "turn_completed",
    receivedAt: "2026-07-14T00:00:02.000Z",
  } satisfies AppServerTimelineEntry;
  const appServer = createFakeAppServer({
    resolveTimelineEntry: (entry) => ({
      entry,
      turn: entry.kind === "turn_completed"
        ? {
          id: "turn-2",
          threadId: "thread-coordinator",
          status: "completed",
          items: {},
          itemOrder: [],
          finalResponse: "",
          completedAt: entry.receivedAt,
          updatedAt: entry.receivedAt,
        }
        : undefined,
    }),
  });
  const fixture = createAgentFixture("agent-turn-activity", {
    appServer,
    domain: createStaticDomain("domain-agent-turn-activity", []),
  });
  const coordinator = new CoordinatorAgent(fixture.options);
  fixture.registry.registerAgent(coordinator);
  fixture.registry.bindThread(coordinator.agentId, started.threadId);
  const turnActivities: AgentTurnActivity[] = [];
  fixture.eventBus.subscribe<AgentTurnActivity>(
    AgentEvents.activity.turnObserved,
    (event) => {
      turnActivities.push(event.payload);
    },
  );
  new AgentBackend().start();

  appServer.emitTimeline(started);
  appServer.emitTimeline(completed);

  assert.deepEqual(
    turnActivities.map((activity) => [activity.turnId, activity.status, activity.seq]),
    [
      ["turn-2", "inProgress", 8],
      ["turn-2", "completed", 9],
    ],
  );
});

test("AgentBackend logs only health failures from an unbound app-server event burst", () => {
  const appServer = createFakeAppServer();
  const logs: Array<Omit<LogEvent, "timestamp" | "level" | "runId"> & { level: string }> = [];
  const logger = createCaptureLogger(logs);
  const fixture = createAgentFixture("app-server-log-volume", {
    appServer,
    domain: createStaticDomain("domain-app-server-log-volume", []),
    logger,
  });
  new AgentBackend().start();

  for (let seq = 1; seq <= 500; seq += 1) {
    appServer.emitTimeline({
      seq,
      stream: "item",
      kind: "reasoning_summary_delta",
      receivedAt: "2026-07-10T00:00:00.000Z",
      threadId: "unbound-thread",
      turnId: "turn-1",
    });
  }
  appServer.emitTimeline({
    seq: 501,
    stream: "lifecycle",
    kind: "disconnect",
    receivedAt: "2026-07-10T00:01:00.000Z",
  });

  assert.deepEqual(
    logs.map((log) => [log.level, log.module, log.event]),
    [["warn", "runtime.app_server", "disconnected"]],
  );
});

test("AgentBackend stop removes app-server dynamic tool and timeline handlers", () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("agent-backend-stop", {
    appServer,
    domain: createStaticDomain("domain-agent-backend-stop", []),
  });
  const backend = new AgentBackend();

  backend.start();
  assert.ok(appServer.handler);
  assert.equal(appServer.timelineHandlerCount, 1);

  backend.stop();
  backend.stop();
  assert.equal(appServer.handler, undefined);
  assert.equal(appServer.timelineHandlerCount, 0);
});

test("Worker child threads cannot inherit domain tool access from their registered parent", async () => {
  const calls: ScoutDomainDynamicToolCall[] = [];
  const appServer = createFakeAppServer({
    parentThreadIds: {
      "thread-child": "thread-test",
      "thread-grandchild": "thread-child",
    },
  });
  const domain: ScoutDomain = {
    domainId: "domain-child-tool",
    name: "domain-child-tool",
    dynamicToolsForRole: () => [buildDomainTool("domain-child-tool")],
    handleDynamicToolCall(call) {
      calls.push(call);
      return {
        success: true,
        contentItems: [{ type: "inputText", text: "domain result" }],
      };
    },
  };
  const fixture = createAgentFixture("worker-child-domain-tool", { appServer, domain });
  const researcherMount = createMount(fixture.root, "researcher");
  prepareAgent(
    fixture,
    "researcher",
    researcherMount,
    createAssetCommit(researcherMount),
  );
  const researcher = new AgentBuilder().buildWorker("researcher");
  new AgentBackend().start();
  await researcher.startThread();

  assert.ok(appServer.handler);
  const result = await appServer.handler({
    threadId: "thread-grandchild",
    turnId: "turn-child-domain-tool",
    callId: "call-child-domain-tool",
    namespace: "domain-child-tool",
    tool: "DomainProbe",
    arguments: {},
  });

  assert.equal(result.success, false);
  assert.match(result.contentItems[0]?.text ?? "", /Unknown dynamic tool caller thread: thread-grandchild/);
  assert.equal(calls.length, 0);
  assert.equal(fixture.registry.resolveAgentByThreadId("thread-child"), undefined);
  assert.equal(fixture.registry.resolveAgentByThreadId("thread-grandchild"), undefined);
});

test("Child threads cannot call Scout agent lifecycle tools", async () => {
  const appServer = createFakeAppServer({
    parentThreadIds: {
      "thread-child": "thread-test",
    },
  });
  const fixture = createAgentFixture("worker-child-lifecycle-tool", { appServer });
  const researcherMount = createMount(fixture.root, "researcher");
  prepareAgent(
    fixture,
    "researcher",
    researcherMount,
    createAssetCommit(researcherMount),
  );
  const researcher = new AgentBuilder().buildWorker("researcher");
  new AgentBackend().start();
  await researcher.startThread();

  assert.ok(appServer.handler);
  const result = await appServer.handler({
    threadId: "thread-child",
    turnId: "turn-child-submit-task",
    callId: "call-child-submit-task",
    namespace: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
    tool: "SubmitTask",
    arguments: { outcome: "## Outcome" },
  });

  assert.equal(result.success, false);
  assert.match(result.contentItems[0]?.text ?? "", /Unknown dynamic tool caller thread: thread-child/);
});

test("Unknown threads remain unauthorized for domain dynamic tools", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("unknown-domain-tool-caller", { appServer });
  new AgentBackend().start();

  assert.ok(appServer.handler);
  const result = await appServer.handler({
    threadId: "thread-unknown",
    turnId: "turn-unknown-domain-tool",
    callId: "call-unknown-domain-tool",
    namespace: "domain-unknown-domain-tool-caller",
    tool: "DomainProbe",
    arguments: {},
  });

  assert.equal(result.success, false);
  assert.match(result.contentItems[0]?.text ?? "", /Unknown dynamic tool caller thread: thread-unknown/);
});

test("SendMessage reports an undelivered message when the target Worker has no TaskRunner", async () => {
  const appServer = createFakeAppServer();
  const domain = createStaticDomain("domain-send-message-no-worker-runner", []);
  const fixture = createAgentFixture("send-message-no-worker-runner", { appServer, domain });
  const verifierMount = createMount(fixture.root, "verifier");
  const verifierCommit = createAssetCommit(verifierMount);
  new AgentBackend().start();
  prepareAgent(fixture, "verifier", verifierMount, verifierCommit);
  const builder = new AgentBuilder();
  const coordinator = builder.buildCoordinator();
  await coordinator.startThread();
  const verifier = builder.buildWorker("verifier") as WorkerAgent;
  await verifier.startThread();

  assert.ok(appServer.handler);
  const result = await appServer.handler({
    threadId: verifier.threadId ?? "",
    turnId: "turn-send-message",
    callId: "call-send-message",
    namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
    tool: "SendMessage",
    arguments: {
      to: verifier.agentId,
      message: "continue",
    },
  });

  assert.equal(result.success, false);
  assert.match(result.contentItems[0]?.text ?? "", /has no TaskRunner/);
});

test("Worker SendMessage reaches Coordinator and Coordinator output reaches the interaction port", async () => {
  const appServer = createFakeAppServer({
    finalResponse: "Need expected result.",
  });
  const domain = createStaticDomain("domain-worker-message-to-coordinator", []);
  const interactionPort = new CapturingInteractionPort();
  const fixture = createAgentFixture("worker-message-to-coordinator", {
    appServer,
    domain,
    interactionPort,
  });
  const verifierMount = createMount(fixture.root, "verifier");
  const verifierCommit = createAssetCommit(verifierMount);
  new AgentBackend().start();
  prepareAgent(fixture, "verifier", verifierMount, verifierCommit);
  const builder = new AgentBuilder();
  const coordinator = builder.buildCoordinator();
  await coordinator.startThread();
  const verifier = builder.buildWorker("verifier") as WorkerAgent;
  await verifier.startThread();
  const interactionGateway = new InteractionGateway();
  interactionGateway.start();

  assert.ok(appServer.handler);
  const result = await appServer.handler({
    threadId: verifier.threadId ?? "",
    turnId: "turn-send-message",
    callId: "call-send-message",
    namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
    tool: "SendMessage",
    arguments: {
      to: coordinator.agentId,
      message: "Need expected result.",
    },
  });

  assert.equal(result.success, true);
  await waitFor(() => interactionPort.agentMessages.length === 1);
  interactionGateway.stop();

  assert.equal(interactionPort.agentMessages[0]?.text, "Need expected result.");
  assert.ok(appServer.turnInputs.some((turn) =>
    typeof turn.prompt === "string"
    && /<message>\nNeed expected result\.\n<\/message>/.test(turn.prompt)
  ));
});

test("Coordinator journals messages received after the Agent stops without starting another turn", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("coordinator-stopped-message", { appServer });
  const coordinator = new AgentBuilder().buildCoordinator();
  await coordinator.startThread();
  await coordinator.stopAgent("test_shutdown");
  const turnCount = appServer.turnInputs.length;
  const queuedAt = "2026-07-23T00:00:00.000Z";

  const delivered = await coordinator.sendMessage({
    message: agent.turn.task_outcome("## Outcome\n\n- 已完成退出前工作。"),
    delivery: {
      messageId: "shutdown-task-outcome",
      queuedAt,
    },
  });

  assert.equal(delivered.ok, true);
  const queued = fixture.journal.readAll().find((event) =>
    AgentEvents.message.queued.is(event)
    && event.payload.messageId === "shutdown-task-outcome"
  );
  assert.ok(queued && AgentEvents.message.queued.is(queued));
  assert.deepEqual(queued.payload, {
    messageId: "shutdown-task-outcome",
    agentId: coordinator.agentId,
    body: agent.turn.task_outcome("## Outcome\n\n- 已完成退出前工作。"),
    queuedAt,
  });
  await Promise.resolve();
  assert.equal(appServer.turnInputs.length, turnCount);
});

test("Human input tools deliver through Coordinator and update the bound task", async () => {
  let verifier: WorkerAgent | undefined;
  let requestSucceeded = false;
  let repeatedRequestSucceeded = false;
  let responseSucceeded = false;
  let repeatedResponseStatus = "";
  let submitSucceeded = false;
  let staleRequestError = "";
  let staleSubmitError = "";
  let markResponseTurnStarted: (() => void) | undefined;
  const responseTurnStarted = new Promise<void>((resolve) => {
    markResponseTurnStarted = resolve;
  });
  let releaseResponseTurn: (() => void) | undefined;
  const responseTurnRelease = new Promise<void>((resolve) => {
    releaseResponseTurn = resolve;
  });
  const appServer = createFakeAppServer({
    turnIdForTurn: (turn) => turn.prompt?.includes("Forward human response again")
      ? "turn-human-response-repeat"
      : turn.prompt?.includes("Forward human response")
        ? "turn-human-response"
        : turn.prompt?.includes("<human-response>")
          ? "turn-human-response-worker"
          : turn.prompt?.includes("Restate the existing request")
            ? "turn-human-request-repeat-worker"
            : "turn-human-request-worker",
    onRunTurn: async (turn) => {
      const prompt = turn.prompt ?? "";
      if (!verifier || !appServer.handler) return;
      if (prompt.includes("<message>\nForward human response.\n</message>")) {
        const result = await appServer.handler({
          threadId: "thread-test",
          turnId: "turn-human-response",
          callId: "call-human-response",
          namespace: AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE,
          tool: "RespondHumanInput",
          arguments: {
            task_id: verifier.taskRunner?.snapshot().activeTask?.taskId,
            response: "Use staging account.",
          },
        });
        responseSucceeded = result.success;
        return;
      }
      if (prompt.includes("<message>\nForward human response again.\n</message>")) {
        const result = await appServer.handler({
          threadId: "thread-test",
          turnId: "turn-human-response-repeat",
          callId: "call-human-response-repeat",
          namespace: AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE,
          tool: "RespondHumanInput",
          arguments: {
            task_id: verifier.taskRunner?.snapshot().activeTask?.taskId,
            response: "Use staging account.",
          },
        });
        responseSucceeded = result.success;
        repeatedResponseStatus = JSON.parse(result.contentItems[0]?.text ?? "{}").status ?? "";
        return;
      }
      if (prompt.includes("<message>\nPerform lifecycle handoff.\n</message>")) {
        const stale = await appServer.handler({
          threadId: verifier.threadId ?? "",
          turnId: "turn-stale-request",
          callId: "call-stale-request",
          namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
          tool: "RequestHumanInput",
          arguments: {
            request: "Must not be recorded.",
          },
        });
        staleRequestError = stale.contentItems[0]?.text ?? "";
        const result = await appServer.handler({
          threadId: verifier.threadId ?? "",
          turnId: "turn-human-request-worker",
          callId: "call-wait-for-human-input",
          namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
          tool: "RequestHumanInput",
          arguments: {
            request: "Need target account.",
          },
        });
        requestSucceeded = result.success;
        return [{
          namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
          tool: "RequestHumanInput",
          callId: "call-wait-for-human-input",
          arguments: {
            request: "Need target account.",
          },
          success: result.success,
        }];
      }
      if (prompt.includes("<message>\nRestate the existing request.\n</message>")) {
        const result = await appServer.handler({
          threadId: verifier.threadId ?? "",
          turnId: "turn-human-request-repeat-worker",
          callId: "call-wait-for-human-input-repeat",
          namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
          tool: "RequestHumanInput",
          arguments: {
            request: "Need target account.",
          },
        });
        repeatedRequestSucceeded = result.success;
        return [{
          namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
          tool: "RequestHumanInput",
          callId: "call-wait-for-human-input-repeat",
          arguments: {
            request: "Need target account.",
          },
          success: result.success,
        }];
      }
      if (prompt.includes("<human-response>\nUse staging account.\n</human-response>")) {
        markResponseTurnStarted?.();
        await responseTurnRelease;
        const stale = await appServer.handler({
          threadId: verifier.threadId ?? "",
          turnId: "turn-stale-submit",
          callId: "call-stale-submit",
          namespace: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
          tool: "SubmitTask",
          arguments: {
            outcome: "Must not be submitted.",
          },
        });
        staleSubmitError = stale.contentItems[0]?.text ?? "";
        const result = await appServer.handler({
          threadId: verifier.threadId ?? "",
          turnId: "turn-human-response-worker",
          callId: "call-submit-task",
          namespace: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
          tool: "SubmitTask",
          arguments: {
            outcome: "## Outcome\n\n- Artifact: ${SCOUT_ARTIFACT_ROOT}/result.md",
          },
        });
        submitSucceeded = result.success;
      }
    },
  });
  const domain = createStaticDomain("domain-worker-lifecycle-tools", []);
  const fixture = createAgentFixture("worker-lifecycle-tools", { appServer, domain });
  const verifierMount = createMount(fixture.root, "verifier");
  const verifierCommit = createAssetCommit(verifierMount);
  new AgentBackend().start();
  prepareAgent(fixture, "verifier", verifierMount, verifierCommit);
  const builder = new AgentBuilder();
  const coordinator = builder.buildCoordinator();
  await coordinator.startThread();
  fixture.registry.bindThread(coordinator.agentId, "thread-coordinator");
  verifier = builder.buildWorker("verifier") as WorkerAgent;
  await verifier.startThread();
  const assignment = await verifier.assignTask({
    description: "Exercise explicit lifecycle tools",
    phase: "verify",
    prompt: agent.turn.message("Perform lifecycle handoff."),
    isBackgrounded: true,
  });
  assert.equal(assignment.ok, true);
  if (!assignment.ok || !verifier.taskRunner) throw new Error("Expected the Worker task assignment to succeed.");
  const runner = verifier.taskRunner;

  await verifier.runToIdle();

  assert.equal(requestSucceeded, true);
  assert.match(
    staleRequestError,
    /owns active app-server turn turn-human-request-worker, not turn-stale-request/,
  );
  assert.equal(runner.snapshot().activeTask?.status, AgentTaskStatuses.Running);
  const waitingStep = fixture.stepStore.list({ taskId: assignment.value.taskId }).find((step) =>
    step.turnId === "turn-human-request-worker"
  );
  const waitingDisposition = runner.snapshot().activeTask?.dispositions.find((disposition) =>
    disposition.stepId === waitingStep?.stepId
  );
  assert.equal(waitingDisposition?.kind, "waiting_for_human");
  assert.equal(
    waitingDisposition?.kind === "waiting_for_human"
      ? waitingDisposition.request
      : undefined,
    "Need target account.",
  );
  assert.equal(waitingDisposition?.turnId, "turn-human-request-worker");
  assert.equal(waitingDisposition?.callId, "call-wait-for-human-input");
  assert.ok(appServer.turnInputs.some((turn) =>
    turn.prompt?.includes("<wait-for-human-request>\nNeed target account.\n</wait-for-human-request>")
  ));
  const humanToolHandler = appServer.handler;
  if (!humanToolHandler) throw new Error("Expected the dynamic tool handler.");
  const prematureSubmission = await humanToolHandler({
    threadId: verifier.threadId ?? "",
    turnId: "turn-premature-submit",
    callId: "call-premature-submit",
    namespace: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
    tool: "SubmitTask",
    arguments: {
      outcome: "## Outcome\n\n- 仍在等待人工确认。",
    },
  });
  assert.equal(prematureSubmission.success, false);
  assert.match(
    prematureSubmission.contentItems[0]?.text ?? "",
    /cannot be submitted while human request .* is unresolved/,
  );
  const humanRequestEvent = fixture.journal.readAll().find((event) =>
    AgentEvents.humanInput.requested.is(event)
  );
  assert.equal(Boolean(humanRequestEvent), true);
  if (!humanRequestEvent || !AgentEvents.humanInput.requested.is(humanRequestEvent)) {
    throw new Error("Expected the human input request to be journaled.");
  }
  assert.equal(
    fixture.journal.readAll().filter((event) =>
      AgentEvents.message.queued.is(event)
      && event.payload.messageId === humanRequestEvent.payload.message.messageId
    ).length,
    1,
  );

  const repeatedDelivery = await verifier.sendMessage({
    taskId: assignment.value.taskId,
    message: agent.turn.message("Restate the existing request."),
  });
  assert.equal(repeatedDelivery.ok, true);
  await verifier.runToIdle();
  assert.equal(repeatedRequestSucceeded, true);
  assert.equal(runner.snapshot().activeTask?.status, AgentTaskStatuses.Running);
  assert.equal(
    runner.snapshot().activeTask?.dispositions.filter((disposition) =>
      disposition.kind === AgentTaskDispositionKinds.WaitingForHuman
    ).length,
    1,
  );
  assert.equal(
    fixture.journal.readAll().filter((event) =>
      AgentEvents.humanInput.requested.is(event)
    ).length,
    1,
  );

  await coordinator.runToIdle();
  fixture.registry.bindThread(coordinator.agentId, coordinator.threadId ?? "");
  const responseDelivery = await coordinator.sendMessage({
    message: agent.turn.message("Forward human response."),
  });
  assert.equal(responseDelivery.ok, true);
  await coordinator.runToIdle();
  assert.equal(responseSucceeded, true);
  await responseTurnStarted;

  const stepCountAfterResponse = fixture.stepStore.list({ taskId: assignment.value.taskId }).length;
  const repeatedResponseDelivery = await coordinator.sendMessage({
    message: agent.turn.message("Forward human response again."),
  });
  assert.equal(repeatedResponseDelivery.ok, true);
  await coordinator.runToIdle();
  assert.equal(responseSucceeded, true);
  assert.equal(repeatedResponseStatus, "accepted");
  assert.equal(
    fixture.stepStore.list({ taskId: assignment.value.taskId }).length,
    stepCountAfterResponse,
  );
  fixture.registry.bindThread(verifier.agentId, verifier.threadId ?? "");
  releaseResponseTurn?.();
  await verifier.runToIdle();

  assert.equal(submitSucceeded, true);
  assert.match(
    staleSubmitError,
    /owns active app-server turn turn-human-response-worker, not turn-stale-submit/,
  );
  assert.equal(runner.snapshot().activeTask?.status, AgentTaskStatuses.Done);
  const submittedStep = fixture.stepStore.list({ taskId: assignment.value.taskId }).find((step) =>
    step.turnId === "turn-human-response-worker"
  );
  assert.deepEqual(submittedStep?.humanInputReferences, [{
    requestId: humanRequestEvent.payload.requestId,
    kind: "response_consumed",
  }]);
  const humanInputKinds = fixture.stepStore.list()
    .flatMap((step) => step.humanInputReferences)
    .filter((reference) => reference.requestId === humanRequestEvent.payload.requestId)
    .map((reference) => reference.kind)
    .sort();
  assert.deepEqual(humanInputKinds, [
    "request_produced",
    "request_consumed",
    "response_produced",
    "response_consumed",
  ].sort());
  const submittedDisposition = runner.snapshot().activeTask?.dispositions.find((disposition) =>
    disposition.stepId === submittedStep?.stepId
  );
  assert.equal(submittedDisposition?.kind, "handoff_submitted");
  assert.equal(submittedDisposition?.turnId, "turn-human-response-worker");
  assert.equal(submittedDisposition?.callId, "call-submit-task");
  assert.ok(appServer.turnInputs.some((turn) =>
    turn.prompt?.includes(
      "<task-outcome>\n## Outcome\n\n- Artifact: ${SCOUT_RUN_ROOT}/verifier/artifacts/result.md\n</task-outcome>",
    )
  ));
  const submittedOutcome = fixture.journal.readAll().find((event) =>
    AgentEvents.task.outcomeSubmitted.is(event)
  );
  assert.ok(submittedOutcome && AgentEvents.task.outcomeSubmitted.is(submittedOutcome));
  assert.equal(
    submittedOutcome.payload.outcome,
    "## Outcome\n\n- Artifact: ${SCOUT_RUN_ROOT}/verifier/artifacts/result.md",
  );
  const humanResponseEvent = fixture.journal.readAll().find((event) =>
    AgentEvents.humanInput.responded.is(event)
  );
  assert.ok(humanResponseEvent && AgentEvents.humanInput.responded.is(humanResponseEvent));
  assert.equal(
    fixture.journal.readAll().filter((event) =>
      AgentEvents.humanInput.responded.is(event)
    ).length,
    1,
  );
  assert.equal(
    fixture.journal.readAll().filter((event) =>
      AgentEvents.message.queued.is(event)
      && event.payload.messageId === humanResponseEvent.payload.message.messageId
    ).length,
    1,
  );
  assert.equal(
    fixture.journal.readAll().filter((event) =>
      AgentEvents.message.consumed.is(event)
      && event.payload.messageId === humanResponseEvent.payload.message.messageId
    ).length,
    1,
  );

  if (!appServer.handler) throw new Error("Expected the dynamic tool handler.");
  const coordinatorRequest = await appServer.handler({
    threadId: "thread-coordinator",
    turnId: "turn-invalid-human-request",
    callId: "call-invalid-human-request",
    namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
    tool: "RequestHumanInput",
    arguments: {
      request: "Need another account.",
    },
  });
  assert.equal(coordinatorRequest.success, false);
  assert.match(coordinatorRequest.contentItems[0]?.text ?? "", /only available to Worker agents/);

  const workerResponse = await appServer.handler({
    threadId: verifier.threadId ?? "",
    turnId: "turn-invalid-human-response",
    callId: "call-invalid-human-response",
    namespace: AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE,
    tool: "RespondHumanInput",
    arguments: {
      task_id: assignment.value.taskId,
      response: "Use another account.",
    },
  });
  assert.equal(workerResponse.success, false);
  assert.match(workerResponse.contentItems[0]?.text ?? "", /only available to the Coordinator agent/);
  await coordinator.stopAgent("test_cleanup");
});

test("ArchiveTask releases one TaskRunner while preserving its thread and Step runner", async () => {
  const appServer = createFakeAppServer();
  const domain = createStaticDomain("domain-archive-task", []);
  const fixture = createAgentFixture("archive-task", { appServer, domain });
  const verifierMount = createMount(fixture.root, "verifier");
  const verifierCommit = createAssetCommit(verifierMount);
  new AgentBackend().start();
  prepareAgent(fixture, "verifier", verifierMount, verifierCommit);
  const builder = new AgentBuilder();
  const coordinator = builder.buildCoordinator();
  await coordinator.startThread();
  const verifier = builder.buildWorker("verifier") as WorkerAgent;
  await verifier.startThread();
  const stepRunner = verifier.stepRunner;
  fixture.registry.bindThread(coordinator.agentId, "thread-coordinator");
  const workerThreadId = verifier.threadId;
  const firstAssignment = await verifier.assignTask({
    description: "Verify the first BDD",
    phase: "verify",
    prompt: agent.turn.message("Verify the first behavior."),
    isBackgrounded: true,
  });
  assert.equal(firstAssignment.ok, true);
  if (!firstAssignment.ok) throw new Error("Expected the first task assignment to succeed.");
  assert.equal(firstAssignment.value.taskId, "verifier-task-0001");

  assert.ok(appServer.handler);
  const result = await appServer.handler({
    threadId: "thread-coordinator",
    turnId: "turn-archive-task",
    callId: "call-archive-task",
    namespace: AGENT_ARCHIVE_TASK_TOOL_NAMESPACE,
    tool: "ArchiveTask",
    arguments: {
      task_id: firstAssignment.value.taskId,
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.contentItems[0]?.text ?? "{}"), {
    status: "archived",
    taskId: "verifier-task-0001",
    agentId: "verifier",
    role: "verifier",
  });
  assert.equal(fixture.taskStore.getTask("verifier-task-0001"), undefined);
  assert.equal(verifier.taskRunner, undefined);
  assert.equal(verifier.threadId, workerThreadId);
  assert.equal(verifier.stepRunner, stepRunner);

  const secondAssignment = await verifier.assignTask({
    description: "Verify the second BDD",
    phase: "verify",
    prompt: agent.turn.message("Verify the second behavior."),
    isBackgrounded: true,
  });
  assert.equal(secondAssignment.ok, true);
  if (!secondAssignment.ok) throw new Error("Expected the second task assignment to succeed.");
  assert.equal(secondAssignment.value.taskId, "verifier-task-0002");
  assert.equal(secondAssignment.value.taskSequence, 2);
  assert.equal(verifier.threadId, workerThreadId);
  assert.equal(verifier.stepRunner, stepRunner);

  await verifier.archiveTask(secondAssignment.value.taskId);
  await coordinator.stopAgent("test_cleanup");
});

test("ArchiveTask rejects non-Coordinator callers", async () => {
  const appServer = createFakeAppServer();
  const domain = createStaticDomain("domain-archive-task-role", []);
  const fixture = createAgentFixture("archive-task-role", { appServer, domain });
  const verifierMount = createMount(fixture.root, "verifier");
  const verifierCommit = createAssetCommit(verifierMount);
  new AgentBackend().start();
  prepareAgent(fixture, "verifier", verifierMount, verifierCommit);
  const builder = new AgentBuilder();
  const verifier = builder.buildWorker("verifier") as WorkerAgent;
  await verifier.startThread();

  assert.ok(appServer.handler);
  const result = await appServer.handler({
    threadId: verifier.threadId ?? "",
    turnId: "turn-archive-task-role",
    callId: "call-archive-task-role",
    namespace: AGENT_ARCHIVE_TASK_TOOL_NAMESPACE,
    tool: "ArchiveTask",
    arguments: {
      task_id: "verifier-task-0001",
    },
  });

  assert.equal(result.success, false);
  assert.match(result.contentItems[0]?.text ?? "", /only available to the Coordinator agent/);
});

test("SubmitTask rejects a Coordinator caller", async () => {
  const appServer = createFakeAppServer();
  const domain = createStaticDomain("domain-worker-lifecycle-tool-role", []);
  const fixture = createAgentFixture("worker-lifecycle-tool-role", { appServer, domain });
  new AgentBackend().start();
  const coordinator = new AgentBuilder().buildCoordinator();
  await coordinator.startThread();

  assert.ok(appServer.handler);
  const submitResult = await appServer.handler({
    threadId: coordinator.threadId ?? "",
    turnId: "turn-submit-task-role",
    callId: "call-submit-task-role",
    namespace: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
    tool: "SubmitTask",
    arguments: {
      outcome: "## Outcome",
    },
  });

  assert.equal(submitResult.success, false);
  assert.match(submitResult.contentItems[0]?.text ?? "", /only available to Worker agents/);
  await coordinator.stopAgent("test_cleanup");
});

test("AgentTaskStore snapshots are immutable from callers", () => {
  const fixture = createAgentFixture("task-store-immutable");
  const task = fixture.taskStore.addTask({
    type: "local_agent",
    taskId: "task-immutable",
    taskSequence: 1,
    agentId: "agent-1",
    role: "verifier",
    phase: "verify",
    description: "Immutable task",
    initialPrompt: "Do work",
    status: AgentTaskStatuses.Queued,
    isBackgrounded: true,
    stepIds: [],
    dispositions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  task.status = "failed";
  const stored = fixture.taskStore.getTask("task-immutable");

  assert.equal(stored?.status, AgentTaskStatuses.Queued);
});

function createAgentFixture(
  name: string,
  input: {
    appServer?: ReturnType<typeof createFakeAppServer>;
    domain?: ScoutDomain;
    logger?: Logger;
    interactionPort?: RuntimeInteractionPort;
    scheduler?: Scheduler;
  } = {},
): {
  root: string;
  mount: CodexMount;
  assetCommit: AssetCommit;
  options: ScoutAgentOptions;
  preparedAgents: RunEnvironment["agents"];
  registry: AgentRegistry;
  taskStore: AgentTaskStore;
  stepStore: RunScope["stepStore"];
  eventBus: InMemoryEventBus;
  logger: Logger;
  journal: RunJournal;
} {
  const root = mkdtempSync(join(tmpdir(), `scout-${name}-`));
  const mount = createMount(root, "coordinator");
  const assetCommit = createAssetCommit(mount);
  const appServer = input.appServer ?? createFakeAppServer();
  const domain = input.domain ?? createStaticDomain(`domain-${name}`, []);
  const eventBus = new InMemoryEventBus();
  const logger = input.logger ?? createNoopLogger();
  const contextBundle = buildRunContextBundle({
    runId: `run-${name}`,
    assetCommit,
  });
  const runId = `run-${name}`;
  const runRoot = join(root, "run", runId);
  const journal = RunJournal.create({ runId, runRoot });
  const manifestStore = new RunManifestStore(runRoot);
  if (releaseTestRunScope) {
    throw new Error("Test run scope was not released before creating another fixture.");
  }
  const preparedAgents = {
    ["coordinator"]: runAgentEnvironment(
      "coordinator",
      mount,
      assetCommit,
    ),
  } as RunEnvironment["agents"];
  const scope = new RunScope({
    runId,
    scoutRoot: root,
    runRoot,
    logger,
    eventBus,
    scheduler: input.scheduler ?? createTestScheduler(),
    interactionPort: input.interactionPort ?? new NoopRuntimeInteractionPort(),
    domain,
    journal,
    manifestStore,
    terminate: async () => undefined,
  });
  scope.setAppServer(appServer);
  scope.setEnvironment({
    agents: preparedAgents,
    rootAccess: {
      mountRoots: [mount.mountRoot],
      readableRoots: [],
      writableRoots: [],
    },
    contextBundle,
  });
  const releaseScope = installRunScope(scope);
  const journalWriter = new RunJournalWriter();
  journalWriter.start();
  const createdAt = new Date().toISOString();
  eventBus.publish(
    RunEvents.run.created,
    { runId, scoutRoot: root, createdAt },
    { occurredAt: createdAt },
  );
  manifestStore.create({
    runId,
    scoutRoot: root,
    createdAt,
    checkpointSeq: journal.lastSeq,
  });
  releaseTestRunScope = () => {
    journalWriter.stop();
    releaseScope();
    journal.close();
  };
  const registry = scope.agentRegistry;
  const taskStore = scope.taskStore;
  const stepStore = scope.stepStore;
  const options: ScoutAgentOptions = {
    agentMount: mount,
    assetCommit,
  };
  return {
    root,
    mount,
    assetCommit,
    options,
    preparedAgents,
    registry,
    taskStore,
    stepStore,
    eventBus,
    logger,
    journal,
  };
}

function prepareAgent(
  fixture: ReturnType<typeof createAgentFixture>,
  role: ScoutAgentRole,
  mount: CodexMount,
  assetCommit: AssetCommit,
): void {
  fixture.preparedAgents[role] = runAgentEnvironment(role, mount, assetCommit);
}

function runAgentEnvironment(
  role: ScoutAgentRole,
  mount: CodexMount,
  assetCommit: AssetCommit,
): RunEnvironment["agents"][ScoutAgentRole] {
  return {
    role,
    mount,
    preflight: { status: "passed" },
    preflightPath: join(mount.mountRoot, "mount-preflight.json"),
    assetCommit,
    assetCommitPath: join(mount.runRoot, "asset-commit.json"),
  };
}

function createMount(root: string, role: ScoutAgentRole): CodexMount {
  const mountRoot = join(root, role, "mount");
  const artifactRoot = join(root, role, "artifacts");
  const logsRoot = join(root, role, "logs");
  const tempRoot = join(root, role, "tmp");
  mkdirSync(join(mountRoot, "agents"), { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(logsRoot, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });
  writeFileSync(join(mountRoot, "AGENTS.md"), "common instructions", "utf8");
  if (role !== "coordinator") {
    writeFileSync(join(mountRoot, "agents", "worker.AGENTS.md"), "worker instructions", "utf8");
  }
  const guidanceSkills = role === "coordinator"
    ? [
      "tool-scout-assign-task",
      "tool-scout-send-message",
      "tool-scout-respond-human-input",
      "tool-scout-archive-task",
      "tool-scout-submit-phase-outcome",
      "tool-domain-probe",
    ]
    : [
      "tool-scout-send-message",
      "tool-scout-request-human-input",
      "tool-scout-submit-task",
      "tool-domain-probe",
    ];

  return {
    agentId: role,
    agentProfile: {
      config: "config/config.toml",
      multiAgent: role !== "coordinator",
      maxThreads: 6,
      maxDepth: 1,
      customAgents: role === "coordinator" ? [] : ["scout-helper"],
      model: {
        id: "gpt-5.5",
        provider: "GuruOpenAI",
        reasoningEffort: "high",
        reasoningSummary: "concise",
      },
      phases: [{
        ["coordinator"]: "Synthesis",
        ["researcher"]: "research",
        ["verifier"]: "verify",
        ["validator"]: "research-reviewer",
      }[role] ?? "verify"],
      resourceParks: [],
      shellTools: [],
      mcpServers: [],
      plugins: [],
      readableRoots: [],
      writableRoots: [],
    },
    assetCommitId: `ac_${role}`,
    mountId: `mount-${role}`,
    scoutRoot: root,
    mountRoot,
    runRoot: root,
    artifactRoot,
    logsRoot,
    tempRoot,
    issues: [],
    readableRoots: [root],
    writableRoots: [artifactRoot],
    shellTools: [],
    mcpServers: [],
    customAgents: role === "coordinator" ? [] : ["scout-helper"],
    skills: guidanceSkills.map((name) => ({
      name,
      type: "tool" as const,
      description: `${name} description`,
      summary: `${name} summary`,
      family: ["tool", "test"],
      requiredSkills: [],
      optionalSkills: [],
      path: `.scout/skill/tool/test/${name}/SKILL.md`,
    })),
    plugins: [],
    manifestPath: join(mountRoot, "mount-manifest.json"),
    resourceHash: "hash-test",
  };
}

function createAssetCommit(mount: CodexMount): AssetCommit {
  return {
    ...mount,
    createdAt: "2026-06-29T00:00:00.000Z",
    status: "preflight_passed",
  };
}

function createStaticDomain(domainId: string, tools: AgentDynamicToolSpec[]): ScoutDomain {
  return {
    domainId,
    name: domainId,
    dynamicToolsForRole: () => tools,
  };
}

function buildDomainTool(namespace: string): AgentDynamicToolSpec {
  return {
    guidanceSkill: "tool-domain-probe",
    namespace,
    name: "DomainProbe",
    description: "domain probe",
    inputSchema: {
      type: "object",
      properties: {},
    },
  };
}

class CapturingInteractionPort implements RuntimeInteractionPort {
  readonly disclosures: RuntimeDisclosureEvent[] = [];
  readonly activities: AgentActivity[] = [];
  readonly turnActivities: AgentTurnActivity[] = [];
  readonly taskEvents: ScoutEvent[] = [];
  readonly agentMessages: AgentMessageReply[] = [];

  async publishRunLifecycleSnapshot(_snapshot: RunLifecycleSnapshot): Promise<void> {
    return undefined;
  }

  async publishSubprocessProgress(_progress: SubprocessProgressSnapshot): Promise<void> {
    return undefined;
  }

  async disclose(event: RuntimeDisclosureEvent): Promise<void> {
    this.disclosures.push(event);
  }

  async publishAgentActivity(activity: AgentActivity): Promise<void> {
    this.activities.push(activity);
  }

  async publishAgentTurnActivity(activity: AgentTurnActivity): Promise<void> {
    this.turnActivities.push(activity);
  }

  async publishTaskEvent(event: ScoutEvent): Promise<void> {
    this.taskEvents.push(event);
  }

  async restoreTaskSnapshot(_task: AgentTaskState): Promise<void> {
    return undefined;
  }

  async receiveAgentMessage(message: AgentMessageReply): Promise<void> {
    this.agentMessages.push(message);
  }

  async restoreUserMessage(): Promise<void> {
    return undefined;
  }

  sendAgentMessage(_handler: (message: AgentMessageSend) => void | Promise<void>): RuntimeInteractionUnsubscribe {
    return () => {
      // no-op
    };
  }
}

function createNoopLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}

function createCaptureLogger(
  logs: Array<Omit<LogEvent, "timestamp" | "level" | "runId"> & { level: string }>,
): Logger {
  return {
    debug: (input: Omit<LogEvent, "timestamp" | "level" | "runId">) => logs.push({ level: "debug", ...input }),
    info: (input: Omit<LogEvent, "timestamp" | "level" | "runId">) => logs.push({ level: "info", ...input }),
    warn: (input: Omit<LogEvent, "timestamp" | "level" | "runId">) => logs.push({ level: "warn", ...input }),
    error: (input: Omit<LogEvent, "timestamp" | "level" | "runId">) => logs.push({ level: "error", ...input }),
  } as unknown as Logger;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(predicate(), true);
}

function readCoordinatorTaskAssignedObservations(turnInputs: Array<{ prompt?: string }>): Array<{
  agentId?: string;
  taskId?: string;
}> {
  return turnInputs
    .map((turn) => turn.prompt)
    .filter((prompt): prompt is string => typeof prompt === "string")
    .flatMap((prompt) => {
      return attachments.readTagBlock(prompt, CoordinatorContextTags.Observation)
        .map((block) => {
          if (!block.body.startsWith("### Task Assigned")) return undefined;
          return {
            agentId: readMarkdownListValue(block.body, "Agent ID"),
            taskId: readMarkdownListValue(block.body, "Task ID"),
          };
        })
        .filter((observation): observation is {
          agentId: string;
          taskId: string;
        } => typeof observation?.agentId === "string"
          && typeof observation.taskId === "string");
    });
}

function readCoordinatorTaskNotAssignedObservations(turnInputs: Array<{ prompt?: string }>): Array<{
  agentId?: string;
  role?: string;
  activeTaskId?: string;
  requestedDescription?: string;
  reason?: string;
}> {
  return turnInputs
    .map((turn) => turn.prompt)
    .filter((prompt): prompt is string => typeof prompt === "string")
    .flatMap((prompt) => {
      return attachments.readTagBlock(prompt, CoordinatorContextTags.Observation)
        .filter((block) => block.body.startsWith("### Task Not Assigned"))
        .map((block) => ({
          agentId: readMarkdownListValue(block.body, "Agent ID"),
          role: readMarkdownListValue(block.body, "Role"),
          activeTaskId: readMarkdownListValue(block.body, "Active Task ID"),
          requestedDescription: readMarkdownListValue(block.body, "Requested Task"),
          reason: readMarkdownListValue(block.body, "Reason"),
        }));
    });
}

function readMarkdownListValue(markdown: string, label: string): string | undefined {
  const prefix = `- ${label}: `;
  return markdown.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length);
}

interface TestToolCall {
  namespace?: string | null;
  tool: string;
  callId?: string;
  arguments?: unknown;
  success?: boolean | null;
}

function createFakeAppServer(options: {
  onRunTurn?: (
    turn: { prompt?: string },
  ) => TestToolCall[] | void | Promise<TestToolCall[] | void>;
  onBeforeTurnStarted?: (turn: { prompt?: string }) => void | Promise<void>;
  onInterruptTurn?: (input: { threadId: string; turnId: string }) => void | Promise<void>;
  onCancelTurnWait?: (threadId: string, error: Error) => void;
  finalResponse?: string;
  turnStatus?: "completed" | "failed" | "interrupted";
  turnError?: unknown;
  turnIds?: string[];
  turnIdForTurn?: (turn: { prompt?: string }, index: number) => string;
  resolveTimelineEntry?: (entry: AppServerTimelineEntry) => AppServerResolvedTimelineEntry;
  parentThreadIds?: Record<string, string | null>;
  threadSnapshot?: (threadId: string) => AppServerThreadState | undefined;
} = {}): CodexAppServerClient & {
  handler?: DynamicToolCallHandler;
  readonly timelineHandlerCount: number;
  turnInputs: Array<{
    prompt?: string;
    model?: string;
    reasoningEffort?: string;
    reasoningSummary?: string;
    permissions?: string;
  }>;
  threadInputs: Array<{
    model?: string;
    modelProvider?: string;
    reasoningEffort?: string;
    permissions?: string;
    runtimeWorkspaceRoots?: string[];
  }>;
  interruptInputs: Array<{ threadId: string; turnId: string }>;
  cancelTurnWaitInputs: Array<{ threadId: string; error: string }>;
  emitTimeline(entry: AppServerTimelineEntry): void;
} {
  const timelineHandlers: Array<(entry: AppServerTimelineEntry) => void> = [];
  const appServer = {
    turnInputs: [] as Array<{
      prompt?: string;
      model?: string;
      reasoningEffort?: string;
      reasoningSummary?: string;
      permissions?: string;
    }>,
    threadInputs: [] as Array<{
      model?: string;
      modelProvider?: string;
      reasoningEffort?: string;
      permissions?: string;
      runtimeWorkspaceRoots?: string[];
    }>,
    interruptInputs: [] as Array<{ threadId: string; turnId: string }>,
    cancelTurnWaitInputs: [] as Array<{ threadId: string; error: string }>,
    get timelineHandlerCount(): number {
      return timelineHandlers.length;
    },
    setDynamicToolCallHandler(handler: DynamicToolCallHandler): () => void {
      appServer.handler = handler;
      return () => {
        if (appServer.handler === handler) appServer.handler = undefined;
      };
    },
    onTimeline(handler: (entry: AppServerTimelineEntry) => void): () => void {
      timelineHandlers.push(handler);
      return () => {
        const index = timelineHandlers.indexOf(handler);
        if (index >= 0) timelineHandlers.splice(index, 1);
      };
    },
    emitTimeline(entry: AppServerTimelineEntry): void {
      for (const handler of timelineHandlers) {
        handler(entry);
      }
    },
    resolveTimelineEntry(entry: AppServerTimelineEntry): AppServerResolvedTimelineEntry {
      return options.resolveTimelineEntry?.(entry) ?? { entry };
    },
    threadSnapshot(threadId: string): AppServerThreadState | undefined {
      const snapshot = options.threadSnapshot?.(threadId);
      if (snapshot) return snapshot;
      const parentThreadId = options.parentThreadIds?.[threadId];
      if (parentThreadId === undefined) return undefined;
      return {
        id: threadId,
        meta: {
          id: threadId,
          parentThreadId,
        },
        plan: {
          explanation: "",
          steps: [],
        },
        turns: {},
        turnOrder: [],
        updatedAt: "2026-07-20T00:00:00.000Z",
      };
    },
    turnSnapshot(threadId: string, turnId: string) {
      return options.threadSnapshot?.(threadId)?.turns[turnId];
    },
    startThread: async (threadInput: ThreadStartOptions) => {
      appServer.threadInputs.push(threadInput);
      return {
        threadId: "thread-test",
        startInput: {
          cwd: threadInput.cwd,
          runtimeWorkspaceRoots: threadInput.runtimeWorkspaceRoots,
          model: threadInput.model,
          modelProvider: threadInput.modelProvider,
          approvalPolicy: threadInput.approvalPolicy ?? "never",
          permissions: threadInput.permissions,
          ephemeral: threadInput.ephemeral ?? true,
          config: threadInput.reasoningEffort === undefined
            ? threadInput.config
            : {
                ...(threadInput.config ?? {}),
                model_reasoning_effort: threadInput.reasoningEffort,
              },
          baseInstructions: threadInput.baseInstructions,
          developerInstructions: threadInput.developerInstructions,
          dynamicTools: threadInput.dynamicTools,
        },
        response: {
          thread: { id: "thread-test" },
        },
      };
    },
    startSession: async () => undefined,
    close: () => undefined,
    request: async (method: string, params: unknown) => {
      return {
        method,
        params,
      };
    },
    setThreadGoal: async () => {
      throw new Error("ephemeral thread does not support goals");
    },
    interruptTurn: async (input: { threadId: string; turnId: string }) => {
      appServer.interruptInputs.push(input);
      await options.onInterruptTurn?.(input);
      return {};
    },
    cancelTurnWait: (threadId: string, error = new Error(`Turn wait cancelled for thread ${threadId}.`)) => {
      appServer.cancelTurnWaitInputs.push({
        threadId,
        error: error.message,
      });
      options.onCancelTurnWait?.(threadId, error);
    },
    runTurn: async (turnInput: {
      prompt?: string;
      model?: string;
      reasoningEffort?: string;
      reasoningSummary?: string;
      permissions?: string;
      onTurnStarted?: (turnId: string) => void;
    }) => {
      const turnIndex = appServer.turnInputs.length;
      const turnId = options.turnIdForTurn?.(turnInput, turnIndex)
        ?? options.turnIds?.[turnIndex]
        ?? "turn-test";
      appServer.turnInputs.push(turnInput);
      await options.onBeforeTurnStarted?.(turnInput);
      turnInput.onTurnStarted?.(turnId);
      const toolCalls = await options.onRunTurn?.(turnInput);
      return {
        turnId,
        finalResponse: options.finalResponse ?? "",
        response: {},
        turnSnapshot: options.turnStatus
          ? {
            id: turnId,
            threadId: "thread-test",
            status: options.turnStatus,
            error: options.turnError,
            items: {},
            itemOrder: [],
            finalResponse: options.finalResponse ?? "",
            updatedAt: "2026-08-01T00:00:00.000Z",
          }
          : undefined,
        progressItems: toolCalls?.map((toolCall, index) => ({
          sequence: index + 1,
          item: {
            id: toolCall.callId ?? `dynamic-tool-${index + 1}`,
            type: "dynamicToolCall",
            namespace: toolCall.namespace,
            tool: toolCall.tool,
            arguments: toolCall.arguments,
            success: toolCall.success,
          },
        })) ?? [],
      };
    },
  } as unknown as CodexAppServerClient & {
    handler?: DynamicToolCallHandler;
    readonly timelineHandlerCount: number;
    turnInputs: Array<{
      prompt?: string;
      model?: string;
      reasoningEffort?: string;
      reasoningSummary?: string;
      permissions?: string;
    }>;
    threadInputs: Array<{
      model?: string;
      modelProvider?: string;
      reasoningEffort?: string;
    }>;
    interruptInputs: Array<{ threadId: string; turnId: string }>;
    cancelTurnWaitInputs: Array<{ threadId: string; error: string }>;
    emitTimeline(entry: AppServerTimelineEntry): void;
  };
  return appServer;
}
