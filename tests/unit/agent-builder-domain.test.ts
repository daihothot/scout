import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentBuilder } from "../../src/agent/builder/agent-builder.js";
import { AgentTimelineBackend } from "../../src/agent/backend/timeline/agent-timeline-backend.js";
import { AgentDynamicToolBackend } from "../../src/agent/backend/dynamic-tool/agent-dynamic-tool-backend.js";
import { AgentRegistry } from "../../src/agent/core/agent-registry.js";
import { AgentTaskStore } from "../../src/agent/task/agent-task-store.js";
import { CoordinatorAgent } from "../../src/agent/roles/coordinator-agent.js";
import type { ScoutAgentOptions } from "../../src/agent/core/scout-agent.js";
import {
  AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
  AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
  AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE,
  AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
  AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
  AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
  AGENT_START_WORKFLOW_TOOL_NAMESPACE,
} from "../../src/agent/tools/agent-tools.js";
import {
  scoutAgentPermissionProfile,
  type AgentThreadSnapshot,
  type ScoutAgentPhase,
  type ScoutAgentRole,
} from "../../src/agent/thread/types.js";
import type { AgentTurnCompletedEvent } from "../../src/agent/thread/turn-events.js";
import type { AgentDynamicToolSpec } from "../../src/agent/tools/types.js";
import { EventSubscriptionPriorities, InMemoryEventBus } from "../../src/core/events/index.js";
import { createGraphState, Graph, projectWorkflowState, Scheduler, Workflow, WorkflowEvents } from "../../src/core/workflow/index.js";
import { Benchmarks, ScoutBenchmarks } from "../../src/core/benchmarks/index.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import type {
  DynamicToolCallHandler,
  DynamicToolCallResponse,
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
import {
  AssetStore,
  type AssetCommit,
  type CodexMount,
} from "../../src/asset-store/index.js";
import {
  BaseDomain,
  DomainAgentBackend,
  ScoutDomainId,
  type ScoutDomain,
} from "../../src/domain/index.js";
import type { ScoutDomainDynamicToolCall } from "../../src/domain/types.js";
import {
  buildRunContextBundle,
  type RunEnvironment,
} from "../../src/run/types.js";
import {
  currentRunScope,
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
  AgentTurnActivity,
} from "../../src/agent/activity/activity-event.js";
import type { AgentNativeSubagentEvent } from "../../src/agent/subagent/subagent-events.js";
import type { AgentCommandExecutionObservedEvent } from "../../src/agent/command-execution/command-execution-events.js";
import { InteractionGateway } from "../../src/interaction/index.js";
import { attachments } from "../../src/agent/context/index.js";
import { agent } from "../../src/agent/context/agent-attachments.js";
import { CoordinatorContextTags } from "../../src/agent/runner/coordinator/coordinator-attachments.js";
import type { AgentTaskNotAssignedEventPayload } from "../../src/agent/task/task-events.js";
import type { ScoutEvent } from "../../src/core/events/index.js";
import { Journal, readJournalEvents, type JournalEvent } from "../../src/core/journal/index.js";
import { SystemEvents } from "../../src/system/events/index.js";
import type { LogEvent, Logger } from "../../src/core/logging/index.js";
import { WorkerAgent } from "../../src/agent/roles/worker-agent.js";
import type { RunLifecycleSnapshot } from "../../src/run/lifecycle/index.js";
import { createTestScheduler } from "../helpers/run-persistence.js";
import {
  AgentTaskDispositionKinds,
  AgentTaskStatuses,
  type AgentTaskState,
} from "../../src/agent/task/types.js";
import { RunEvents } from "../../src/run/events/index.js";
import { RunManifestStore } from "../../src/run/persistence/index.js";
import { AgentsStage } from "../../src/run/lifecycle/stages/agents-stage.js";
import { RestoreAgentsStage } from "../../src/run/resume/stages/restore-agents-stage.js";
import { RestoreTasksStage } from "../../src/run/resume/stages/restore-tasks-stage.js";
import { projectRun } from "../../src/run/resume/projection/index.js";

let releaseTestRunScope: (() => Promise<void>) | undefined;

afterEach(async () => {
  const release = releaseTestRunScope;
  releaseTestRunScope = undefined;
  await release?.();
});

test("AgentBuilder creates a coordinator with orchestration tools only", () => {
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
  assert.equal(tools.some((tool) => tool.name === "ArchiveTask"), false);
  assert.ok(tools.some((tool) =>
    tool.namespace === AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE
    && tool.name === "SubmitPhaseOutcome"
  ));
  assert.equal(tools.some((tool) => tool.name === "SubmitTask"), false);
  assert.equal(tools.some((tool) => tool.name === "RequestHumanInput"), false);
  assert.equal(tools.some((tool) => tool.namespace === "domain-a"), false);
  assert.equal(tools.some((tool) => tool.namespace === "domain-b"), false);
  const instructions = agent.spec.developerInstructions ?? "";
  assert.match(instructions, /common instructions/);
  assert.doesNotMatch(instructions, /worker instructions/);
  assert.match(instructions, /coordinator instructions/);
  assert.equal(instructions.match(/common instructions/g)?.length, 1);
  assert.ok(
    instructions.indexOf("common instructions") < instructions.indexOf("coordinator instructions"),
  );
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

test("AgentBuilder unions and deduplicates Domain tools across a Worker's Phases", () => {
  const requestedPhases: string[] = [];
  const shared = buildDomainTool("domain-shared");
  const domain: ScoutDomain = {
    description: { id: ScoutDomainId.Validation, name: "domain-phase-tools" },
    backend: new class extends DomainAgentBackend {
      override dynamicToolsForPhase(phase: ScoutAgentPhase) {
        requestedPhases.push(phase);
        return phase === "research"
          ? [shared, buildDomainTool("domain-research")]
          : phase === "verify"
            ? [shared, buildDomainTool("domain-verify")]
            : [];
      }

      override async handleDynamicToolCall() { return undefined; }
    }(),
  };
  const fixture = createAgentFixture("builder-worker-phase-tools", { domain });
  const researcherMount = createMount(fixture.root, "researcher");
  researcherMount.agentProfile.phases = ["research", "verify"];
  prepareAgent(fixture, "researcher", researcherMount, createAssetCommit(researcherMount));

  const worker = new AgentBuilder().buildWorker("researcher");
  const domainNamespaces = (worker.spec.dynamicTools ?? [])
    .filter((tool) => tool.name === "DomainProbe")
    .map((tool) => tool.namespace);

  assert.deepEqual(requestedPhases, ["research", "verify"]);
  assert.deepEqual(domainNamespaces, ["domain-shared", "domain-research", "domain-verify"]);
});

test("AgentBuilder creates an arbitrary Workflow role as a generic Worker", () => {
  const scheduler = new Scheduler(new Graph(createGraphState({
    domain: "test",
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
  })));
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
  assert.deepEqual(validator.spec.approvalPolicy, { granular: {
    sandbox_approval: false, rules: false, mcp_elicitations: false, request_permissions: true, skill_approval: false,
  } });
  assert.deepEqual(validator.threadSnapshot?.startInput.approvalPolicy, validator.spec.approvalPolicy);
  assert.deepEqual(appServer.turnInputs[0]?.approvalPolicy, validator.spec.approvalPolicy);

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
    currentRunScope().workflow.agentPaths("researcher").artifactRoot,
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
  new AgentDynamicToolBackend().start();
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
  const replacementAssignment = await worker.assignTask({
    description: "Research another BDD after release",
    phase: "research",
    prompt: agent.turn.message("Research another BDD after release."),
    isBackgrounded: true,
  });
  assert.equal(replacementAssignment.ok, true);
  if (!replacementAssignment.ok) throw new Error("Expected replacement assignment to succeed.");
  assert.notEqual(worker.taskRunner, boundRunner);
  assert.equal(worker.stepRunner, reusableStepRunner);
  await worker.stopTask(replacementAssignment.value.taskId, "test_cleanup");
  await worker.runToIdle();
  await worker.releaseTask(replacementAssignment.value.taskId);
  await coordinatorAgent.stopAgent("test_cleanup");
});

test("AssignTask routes through the current Phase and skips a busy first role", async () => {
  const appServer = createFakeAppServer();
  const scheduler = new Scheduler(new Graph(createGraphState({
    domain: "test",
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
  })));
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
  const backend = new AgentDynamicToolBackend();
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
  assert.match(
    assignedTask?.initialPrompt ?? "",
    /<workflow_phase>\ncurrent_domain: test\ncurrent_phase: audit\nworkflow_status: active\n<\/workflow_phase>/,
  );
  assert.equal(assignedTask?.initialPrompt.match(/<workflow_phase>/g)?.length, 1);
  assert.equal(firstWorker.taskRunner?.snapshot().activeTask?.taskId, "auditor-a-task-0001");

  if (assignedTask) {
    await secondWorker.stopTask(assignedTask.taskId, "test_cleanup");
    await secondWorker.runToIdle();
    await secondWorker.releaseTask(assignedTask.taskId);
  }
  await firstWorker.stopTask("auditor-a-task-0001", "test_cleanup");
  await firstWorker.releaseTask("auditor-a-task-0001");
  await coordinatorAgent.stopAgent("test_cleanup");
  backend.stop();
});

test("SubmitPhaseOutcome advances the cursor and schedules one fresh Coordinator Step", async () => {
  const outcomes: DynamicToolCallResponse[] = [];
  const appServer = createFakeAppServer({
    turnIds: ["turn-submit-phase-research", "turn-submit-phase-review", "turn-verify"],
    onRunTurn: async () => {
      const index = appServer.turnInputs.length - 1;
      if (index > 1) return;
      assert.ok(appServer.handler);
      const input = {
        threadId: "thread-test",
        turnId: index === 0 ? "turn-submit-phase-research" : "turn-submit-phase-review",
        callId: `call-submit-phase-${index}`,
        namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
        tool: "SubmitPhaseOutcome", arguments: { outcome: "completed" },
      };
      const accepted = await appServer.handler(input);
      outcomes.push(accepted);
      assert.equal(accepted.success, true);
      const cursor = currentRunScope().workflow.scheduler.snapshot();
      assert.deepEqual(await appServer.handler(input), accepted, "identical delivery must replay its receipt");
      for (const rejected of [
        { ...input, callId: "second-advance" },
        { ...input, arguments: { outcome: "error" } },
        { ...input, turnId: "stale-turn" },
      ]) {
        assert.equal((await appServer.handler(rejected)).success, false);
        assert.deepEqual(currentRunScope().workflow.scheduler.snapshot(), cursor);
      }
    },
  });
  const fixture = createAgentFixture("submit-phase-outcome", { appServer });
  const coordinatorAgent = new AgentBuilder().buildCoordinator();
  await coordinatorAgent.startThread();
  const backend = new AgentDynamicToolBackend();
  backend.start();

  assert.ok(appServer.handler);
  const beforeTurn = await appServer.handler({
    threadId: coordinatorAgent.threadId ?? "",
    turnId: "turn-submit-phase-research",
    callId: "call-submit-phase-research",
    namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
    tool: "SubmitPhaseOutcome",
    arguments: { outcome: "completed" },
  });
  assert.equal(beforeTurn.success, false);
  assert.equal(currentRunScope().workflow.scheduler.snapshot().currentPhase, "research");
  await new InteractionGateway().submitUserMessage({ messageId: "advance-phases", text: "Complete the first two Phases." });
  await coordinatorAgent.runToIdle();
  const afterTurn = await appServer.handler({
    threadId: coordinatorAgent.threadId ?? "",
    turnId: "turn-submit-phase-review",
    callId: "call-submit-phase-review",
    namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
    tool: "SubmitPhaseOutcome",
    arguments: { outcome: "completed" },
  });
  assert.equal(afterTurn.success, false);
  assert.equal(outcomes.length, 2);
  const [first, second] = outcomes;

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
  assert.equal(appServer.turnInputs.length, 3);
  assert.match(
    appServer.turnInputs[1]?.prompt ?? "",
    /<workflow_phase>\ncurrent_domain: test\ncurrent_phase: research-reviewer\nworkflow_status: active\n<\/workflow_phase>/,
  );
  assert.match(
    appServer.turnInputs[2]?.prompt ?? "",
    /<workflow_phase>\ncurrent_domain: test\ncurrent_phase: verify\nworkflow_status: active\n<\/workflow_phase>/,
  );
  for (const input of appServer.turnInputs) {
    assert.equal(input.prompt?.match(/<workflow_phase>/g)?.length, 1);
  }

  await coordinatorAgent.stopAgent("test_cleanup");
  backend.stop();
});

test("SubmitPhaseOutcome rejects a Worker before touching Workflow state", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("phase-outcome-worker", { appServer });
  const mount = createMount(fixture.root, "researcher");
  prepareAgent(fixture, "researcher", mount, createAssetCommit(mount));
  const worker = new AgentBuilder().buildWorker("researcher");
  await worker.startThread();
  const backend = new AgentDynamicToolBackend();
  backend.start();
  try {
    assert.ok(appServer.handler);
    const workflow = currentRunScope().workflow;
    const before = workflow.scheduler.snapshot();
    const result = await appServer.handler({
      threadId: worker.threadId!, turnId: "worker-turn", callId: "worker-phase-outcome",
      namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
      tool: "SubmitPhaseOutcome", arguments: { outcome: "completed" },
    });
    assert.equal(result.success, false);
    assert.match(result.contentItems[0]?.text ?? "", /only available to the Coordinator/);
    assert.deepEqual(workflow.scheduler.snapshot(), before);
  } finally {
    await worker.stopAgent("test_cleanup");
    backend.stop();
  }
});

test("SubmitPhaseOutcome leaves Workflow unchanged while a queued or running Task is unfinished", async (t) => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("phase-outcome-unfinished-task", { appServer });
  const workflow = currentRunScope().workflow;
  const coordinator = new AgentBuilder().buildCoordinator();
  // Isolate the task barrier; real Turn admission and replay are covered above.
  t.mock.method(coordinator, "assertOwnsActiveTurn", () => {});
  await coordinator.startThread();
  const backend = new AgentDynamicToolBackend();
  backend.start();
  const now = new Date().toISOString();
  fixture.taskStore.addTask({
    type: "local_agent", taskId: "unfinished-research", taskSequence: 1,
    agentId: "researcher", role: "researcher", phase: "research",
    description: "Research before moving on", initialPrompt: "Research the input.",
    status: AgentTaskStatuses.Queued, isBackgrounded: true,
    stepIds: [], dispositions: [], createdAt: now, updatedAt: now,
  });

  try {
    assert.ok(appServer.handler);
    for (const status of [AgentTaskStatuses.Queued, AgentTaskStatuses.Running]) {
      fixture.taskStore.updateTask("unfinished-research", (task) => ({ ...task, status }));
      const graphBefore = workflow.scheduler.snapshot();
      const workflowBefore = workflow.snapshot();
      const journalBefore = workflow.readEvents();
      const benchmarksBefore = new ScoutBenchmarks(new Benchmarks(currentRunScope().runRoot)).read();
      for (const outcome of ["completed", "error"]) {
        const result = await appServer.handler({
          threadId: coordinator.threadId ?? "", turnId: "turn-unfinished-phase",
          callId: `reject-${status}-${outcome}`,
          namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
          tool: "SubmitPhaseOutcome", arguments: { outcome },
        });
        assert.equal(result.success, false);
        assert.match(result.contentItems[0]?.text ?? "", /Cannot advance Workflow Phase/);
        assert.match(result.contentItems[0]?.text ?? "", /unfinished-research/);
        await coordinator.runToIdle();
        assert.deepEqual(workflow.scheduler.snapshot(), graphBefore);
        assert.deepEqual(workflow.snapshot(), workflowBefore);
        assert.deepEqual(workflow.readEvents(), journalBefore);
        assert.deepEqual(new ScoutBenchmarks(new Benchmarks(currentRunScope().runRoot)).read(), benchmarksBefore);
        assert.equal(appServer.turnInputs.length, 0);
      }
    }

    fixture.taskStore.updateTask("unfinished-research", (task) => ({
      ...task, status: AgentTaskStatuses.Done, finishedAt: now,
    }));
    const accepted = await appServer.handler({
      threadId: coordinator.threadId ?? "", turnId: "turn-finished-phase",
      callId: "retry-finished-phase", namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
      tool: "SubmitPhaseOutcome", arguments: { outcome: "completed" },
    });
    await coordinator.runToIdle();
    assert.equal(accepted.success, true);
    assert.equal(workflow.scheduler.snapshot().currentPhase, "research-reviewer");
    assert.equal(fixture.taskStore.getTask("unfinished-research")?.status, AgentTaskStatuses.Done);
    assert.equal(appServer.turnInputs.length, 1);
  } finally {
    await coordinator.stopAgent("test_cleanup");
    backend.stop();
  }
});

test("Rejected Phase completion keeps human input reachable through Gateway until the Worker finishes", async (t) => {
  let worker: WorkerAgent | undefined;
  let requested = false;
  let responded = false;
  let submitted = false;
  const appServer = createFakeAppServer({
    threadIds: ["thread-coordinator", "thread-researcher"],
    turnIdForTurn: (turn) => turn.prompt?.includes("<human-response>")
      ? "turn-approved-worker"
      : turn.prompt?.includes("Use the approved account.")
        ? "turn-user-approval"
        : "turn-await-approval",
    onRunTurn: async (turn) => {
      if (!appServer.handler || !worker) return;
      const prompt = turn.prompt ?? "";
      if (prompt.includes("<message>\nWait for approval.\n</message>")) {
        const result = await appServer.handler({
          threadId: worker.threadId ?? "", turnId: "turn-await-approval",
          callId: "request-approval", namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
          tool: "RequestHumanInput", arguments: { request: "Which account is approved?" },
        });
        requested = result.success;
      } else if (prompt.includes("<human-response>")) {
        const result = await appServer.handler({
          threadId: worker.threadId ?? "", turnId: "turn-approved-worker",
          callId: "submit-approved-task", namespace: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
          tool: "SubmitTask", arguments: { outcome: "Research completed using the approved account." },
        });
        submitted = result.success;
      } else if (prompt.includes("Use the approved account.")) {
        const result = await appServer.handler({
          threadId: "thread-coordinator", turnId: "turn-user-approval",
          callId: "respond-approval", namespace: AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE,
          tool: "RespondHumanInput", arguments: {
            task_id: worker.taskRunner?.snapshot().activeTask?.taskId,
            response: "Use the approved account.",
          },
        });
        responded = result.success;
      }
    },
  });
  const fixture = createAgentFixture("phase-outcome-human-input", { appServer });
  const workflow = currentRunScope().workflow;
  const mount = createMount(fixture.root, "researcher");
  prepareAgent(fixture, "researcher", mount, createAssetCommit(mount));
  const builder = new AgentBuilder();
  const coordinator = builder.buildCoordinator();
  // Inject admission here so the test can snapshot only the task barrier's effects.
  t.mock.method(coordinator, "assertOwnsActiveTurn", () => {});
  await coordinator.startThread();
  worker = builder.buildWorker("researcher") as WorkerAgent;
  await worker.startThread();
  const backend = new AgentDynamicToolBackend();
  backend.start();

  try {
    const assignment = await worker.assignTask({
      description: "Research requires human approval", phase: "research",
      prompt: agent.turn.message("Wait for approval."), isBackgrounded: true,
    });
    assert.ok(assignment.ok);
    await worker.runToIdle();
    await coordinator.runToIdle();
    assert.equal(requested, true);
    const waiting = fixture.taskStore.getTask(assignment.value.taskId);
    assert.equal(waiting?.status, AgentTaskStatuses.Running);
    assert.equal(waiting?.dispositions.at(-1)?.kind, AgentTaskDispositionKinds.WaitingForHuman);
    assert.ok(appServer.handler);
    const graphBefore = workflow.scheduler.snapshot();
    const workflowBefore = workflow.snapshot();
    const journalBefore = workflow.readEvents();
    const benchmarksBefore = new ScoutBenchmarks(new Benchmarks(currentRunScope().runRoot)).read();
    const turnsBefore = appServer.turnInputs.length;
    const rejected = await appServer.handler({
      threadId: coordinator.threadId ?? "", turnId: "turn-reject-waiting-phase",
      callId: "reject-waiting-phase", namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
      tool: "SubmitPhaseOutcome", arguments: { outcome: "completed" },
    });
    assert.equal(rejected.success, false);
    assert.match(rejected.contentItems[0]?.text ?? "", /Cannot advance Workflow Phase/);
    await coordinator.runToIdle();
    assert.deepEqual(workflow.scheduler.snapshot(), graphBefore);
    assert.deepEqual(workflow.snapshot(), workflowBefore);
    assert.deepEqual(workflow.readEvents(), journalBefore);
    assert.deepEqual(new ScoutBenchmarks(new Benchmarks(currentRunScope().runRoot)).read(), benchmarksBefore);
    assert.equal(appServer.turnInputs.length, turnsBefore);

    await new InteractionGateway().submitUserMessage({
      messageId: "approval-after-rejected-outcome", text: "Use the approved account.",
    });
    await coordinator.runToIdle();
    await worker.runToIdle();
    await coordinator.runToIdle();
    assert.equal(responded, true);
    assert.equal(submitted, true);
    assert.equal(fixture.taskStore.getTask(assignment.value.taskId)?.status, AgentTaskStatuses.Done);
    assert.ok(workflow.readEvents().some((event) =>
      SystemEvents.interaction.userMessageSubmitted.is(event)
      && event.payload.messageId === "approval-after-rejected-outcome"
    ));
    assert.ok(workflow.readEvents().some((event) => AgentEvents.humanInput.responded.is(event)));
    const accepted = await appServer.handler({
      threadId: coordinator.threadId ?? "", turnId: "turn-retry-approved-phase",
      callId: "retry-approved-phase", namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
      tool: "SubmitPhaseOutcome", arguments: { outcome: "completed" },
    });
    await coordinator.runToIdle();
    assert.equal(accepted.success, true);
    assert.equal(workflow.scheduler.snapshot().currentPhase, "research-reviewer");
    assert.equal(fixture.taskStore.getTask(assignment.value.taskId)?.status, AgentTaskStatuses.Done);
  } finally {
    await worker.stopAgent("test_cleanup");
    await coordinator.stopAgent("test_cleanup");
    backend.stop();
  }
});

test("SubmitPhaseOutcome waits for a stopped Worker's in-flight Step to finish", async (t) => {
  let markWorkerStarted!: () => void;
  const workerStarted = new Promise<void>((resolve) => { markWorkerStarted = resolve; });
  let releaseWorkerTurn!: () => void;
  const workerTurnReleased = new Promise<void>((resolve) => { releaseWorkerTurn = resolve; });
  const appServer = createFakeAppServer({
    threadIds: ["thread-coordinator", "thread-researcher"],
    onRunTurn: async (turn) => {
      if (!turn.prompt?.includes("<message>\nKeep research running.\n</message>")) return;
      markWorkerStarted();
      await workerTurnReleased;
    },
  });
  const fixture = createAgentFixture("phase-outcome-stopped-step", { appServer });
  const workflow = currentRunScope().workflow;
  const mount = createMount(fixture.root, "researcher");
  prepareAgent(fixture, "researcher", mount, createAssetCommit(mount));
  const builder = new AgentBuilder();
  const coordinator = builder.buildCoordinator();
  // The active Coordinator Turn is independent of the Worker drain barrier under test.
  t.mock.method(coordinator, "assertOwnsActiveTurn", () => {});
  await coordinator.startThread();
  const worker = builder.buildWorker("researcher") as WorkerAgent;
  await worker.startThread();
  const backend = new AgentDynamicToolBackend();
  backend.start();

  try {
    const assignment = await worker.assignTask({
      description: "Research still has an active Step", phase: "research",
      prompt: agent.turn.message("Keep research running."), isBackgrounded: true,
    });
    assert.ok(assignment.ok);
    await workerStarted;
    await worker.stopTask(assignment.value.taskId, "Stop before Phase handoff");
    await coordinator.runToIdle();
    assert.equal(fixture.taskStore.getTask(assignment.value.taskId)?.status, AgentTaskStatuses.Stopped);
    const activeStep = fixture.stepStore.list({ taskId: assignment.value.taskId }).find((step) => step.status === "running");
    assert.ok(activeStep);
    assert.ok(appServer.handler);
    const graphBefore = workflow.scheduler.snapshot();
    const workflowBefore = workflow.snapshot();
    const journalBefore = workflow.readEvents();
    const benchmarksBefore = new ScoutBenchmarks(new Benchmarks(currentRunScope().runRoot)).read();
    const turnsBefore = appServer.turnInputs.length;
    const rejected = await appServer.handler({
      threadId: coordinator.threadId ?? "", turnId: "turn-reject-stopped-step",
      callId: "reject-stopped-step", namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
      tool: "SubmitPhaseOutcome", arguments: { outcome: "completed" },
    });
    assert.equal(rejected.success, false);
    assert.match(rejected.contentItems[0]?.text ?? "", /Cannot advance Workflow Phase/);
    assert.ok(rejected.contentItems[0]?.text.includes(activeStep.stepId));
    await coordinator.runToIdle();
    assert.deepEqual(workflow.scheduler.snapshot(), graphBefore);
    assert.deepEqual(workflow.snapshot(), workflowBefore);
    assert.deepEqual(workflow.readEvents(), journalBefore);
    assert.deepEqual(new ScoutBenchmarks(new Benchmarks(currentRunScope().runRoot)).read(), benchmarksBefore);
    assert.equal(appServer.turnInputs.length, turnsBefore);

    releaseWorkerTurn();
    await worker.runToIdle();
    await coordinator.runToIdle();
    assert.equal(fixture.stepStore.getStep(activeStep.stepId)?.status, "completed");
    assert.equal(fixture.taskStore.getTask(assignment.value.taskId)?.status, AgentTaskStatuses.Stopped);
    const accepted = await appServer.handler({
      threadId: coordinator.threadId ?? "", turnId: "turn-retry-stopped-step",
      callId: "retry-stopped-step", namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
      tool: "SubmitPhaseOutcome", arguments: { outcome: "completed" },
    });
    await coordinator.runToIdle();
    assert.equal(accepted.success, true);
    assert.equal(workflow.scheduler.snapshot().currentPhase, "research-reviewer");
    assert.equal(fixture.taskStore.getTask(assignment.value.taskId)?.status, AgentTaskStatuses.Stopped);
  } finally {
    releaseWorkerTurn();
    await worker.runToIdle();
    await worker.stopAgent("test_cleanup");
    await coordinator.stopAgent("test_cleanup");
    backend.stop();
  }
});

test("SubmitPhaseOutcome rejects already accepted work before a Done Task starts its next Step", async (t) => {
  let worker: WorkerAgent | undefined;
  const submissions: boolean[] = [];
  const appServer = createFakeAppServer({
    threadIds: ["thread-coordinator", "thread-researcher"],
    turnIdForTurn: (turn) => turn.prompt?.includes("Revisit the research.") ? "turn-revisit" : "turn-initial-research",
    onRunTurn: async (turn) => {
      const prompt = turn.prompt ?? "";
      if (!worker || !appServer.handler
        || (!prompt.includes("<message>\nInitial research.\n</message>")
          && !prompt.includes("<message>\nRevisit the research.\n</message>"))) return;
      const revisiting = prompt.includes("Revisit the research.");
      const result = await appServer.handler({
        threadId: worker.threadId ?? "", turnId: revisiting ? "turn-revisit" : "turn-initial-research",
        callId: revisiting ? "submit-revisited" : "submit-initial",
        namespace: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
        tool: "SubmitTask", arguments: { outcome: revisiting ? "Research revised." : "Research complete." },
      });
      submissions.push(result.success);
    },
  });
  const fixture = createAgentFixture("phase-outcome-done-pending", { appServer });
  const workflow = currentRunScope().workflow;
  const mount = createMount(fixture.root, "researcher");
  prepareAgent(fixture, "researcher", mount, createAssetCommit(mount));
  const builder = new AgentBuilder();
  const coordinator = builder.buildCoordinator();
  // Keep delivery synchronous with message.queued to test the pending-work barrier.
  t.mock.method(coordinator, "assertOwnsActiveTurn", () => {});
  await coordinator.startThread();
  worker = builder.buildWorker("researcher") as WorkerAgent;
  await worker.startThread();
  const backend = new AgentDynamicToolBackend();
  backend.start();
  let unsubscribe: (() => void) | undefined;

  try {
    const assignment = await worker.assignTask({
      description: "Research may receive a follow-up before handoff", phase: "research",
      prompt: agent.turn.message("Initial research."), isBackgrounded: true,
    });
    assert.ok(assignment.ok);
    await worker.runToIdle();
    await coordinator.runToIdle();
    assert.equal(fixture.taskStore.getTask(assignment.value.taskId)?.status, AgentTaskStatuses.Done);
    assert.deepEqual(submissions, [true]);
    assert.ok(appServer.handler);
    const handler = appServer.handler;
    let queuedSnapshot: ReturnType<WorkerAgent["snapshot"]> | undefined;
    let runningStepCount: number | undefined;
    let rejected: ReturnType<DynamicToolCallHandler> | undefined;
    let before: unknown;
    let after: unknown;
    unsubscribe = fixture.eventBus.subscribe(AgentEvents.message.queued, (event) => {
      if (!AgentEvents.message.queued.is(event) || event.payload.messageId !== "done-task-follow-up") return;
      queuedSnapshot = worker?.snapshot();
      runningStepCount = fixture.stepStore.list({ taskId: assignment.value.taskId }).filter((step) => step.status === "running").length;
      before = {
        graph: workflow.scheduler.snapshot(), workflowState: workflow.snapshot()!, journal: workflow.readEvents(),
        benchmarks: new ScoutBenchmarks(new Benchmarks(currentRunScope().runRoot)).read(), turns: appServer.turnInputs.length,
      };
      rejected = handler({
        threadId: coordinator.threadId ?? "", turnId: "turn-reject-pending-revisit",
        callId: "reject-pending-revisit", namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
        tool: "SubmitPhaseOutcome", arguments: { outcome: "completed" },
      });
      after = {
        graph: workflow.scheduler.snapshot(), workflowState: workflow.snapshot(), journal: workflow.readEvents(),
        benchmarks: new ScoutBenchmarks(new Benchmarks(currentRunScope().runRoot)).read(), turns: appServer.turnInputs.length,
      };
    }, { priority: EventSubscriptionPriorities.Low });
    const sent = await worker.sendMessage({
      taskId: assignment.value.taskId, message: agent.turn.message("Revisit the research."),
      deliveryMode: "queued", delivery: { messageId: "done-task-follow-up", queuedAt: new Date().toISOString() },
    });
    assert.ok(sent.ok);
    assert.equal(queuedSnapshot?.activeTask?.status, AgentTaskStatuses.Done);
    assert.equal(queuedSnapshot?.pendingMessageCount, 1);
    assert.equal(runningStepCount, 0);
    assert.ok(rejected);
    const response = await rejected;
    assert.equal(response.success, false);
    assert.match(response.contentItems[0]?.text ?? "", /Cannot advance Workflow Phase/);
    assert.deepEqual(after, before);
    await worker.runToIdle();
    await coordinator.runToIdle();
    assert.deepEqual(submissions, [true, true]);
    assert.equal(fixture.taskStore.getTask(assignment.value.taskId)?.status, AgentTaskStatuses.Done);
    const accepted = await handler({
      threadId: coordinator.threadId ?? "", turnId: "turn-retry-revisited-phase",
      callId: "retry-revisited-phase", namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
      tool: "SubmitPhaseOutcome", arguments: { outcome: "completed" },
    });
    await coordinator.runToIdle();
    assert.equal(accepted.success, true);
    assert.equal(workflow.scheduler.snapshot().currentPhase, "research-reviewer");
  } finally {
    unsubscribe?.();
    await worker.stopAgent("test_cleanup");
    await coordinator.stopAgent("test_cleanup");
    backend.stop();
  }
});

for (const boundary of ["phase-advanced", "settling"] as const) {
  test(`Worker rejects follow-up work on a Done Task after ${boundary}`, async () => {
    const appServer = createFakeAppServer({ threadIds: ["thread-researcher", "thread-coordinator"] });
    const fixture = createAgentFixture(`done-task-message-${boundary}`, { appServer });
    const workflow = currentRunScope().workflow;
    const mount = createMount(fixture.root, "researcher");
    prepareAgent(fixture, "researcher", mount, createAssetCommit(mount));
    const builder = new AgentBuilder();
    const worker = builder.buildWorker("researcher");
    assert.ok(worker instanceof WorkerAgent);
    await worker.startThread();
    const now = new Date().toISOString();
    const task: AgentTaskState = {
      type: "local_agent", taskId: "completed-research", taskSequence: 1,
      agentId: worker.agentId, role: worker.role, phase: "research",
      description: "Finished research", initialPrompt: agent.turn.message("Research"), status: AgentTaskStatuses.Done,
      isBackgrounded: true, stepIds: [], dispositions: [], createdAt: now, updatedAt: now, finishedAt: now,
    };
    worker.restoreTask({ task, maxTaskSequence: 1 });
    await fixture.eventBus.publishAndWait(AgentEvents.task.assigned, task, { occurredAt: now });
    workflow.scheduler.advance(boundary === "phase-advanced" ? "completed" : "error");
    assert.equal(workflow.snapshot()?.status, boundary === "settling" ? "settling" : "active");
    // Create the Coordinator after the transition so this test isolates admission,
    // without scheduling the independent phase/settlement tick.
    const coordinator = builder.buildCoordinator();
    await coordinator.startThread();
    const backend = new AgentDynamicToolBackend();
    backend.start();
    const before = worker.snapshot();
    const taskBefore = fixture.taskStore.getTask(task.taskId);
    const queuedBefore = workflow.readEvents().filter((event) => AgentEvents.message.queued.is(event));
    const expected = boundary === "settling" ? /Workflow is settling/ : /Task .* belongs to Phase research.*current Phase is research-reviewer/;
    try {
      await assert.rejects(worker.sendMessage({
        taskId: task.taskId, message: agent.turn.message("Reopen old work"), deliveryMode: "queued",
      }), expected);
      assert.ok(appServer.handler);
      for (const to of [task.taskId, worker.agentId]) {
        const response: DynamicToolCallResponse = await appServer.handler({
          threadId: coordinator.threadId ?? "", turnId: "turn-follow-up", callId: `follow-up-${to}`,
          namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE, tool: "SendMessage",
          arguments: { to, message: "Reopen old work" },
        });
        assert.equal(response.success, false);
        assert.match(response.contentItems[0]?.text ?? "", expected);
      }
      await worker.runToIdle();
      assert.deepEqual(worker.snapshot(), before);
      assert.deepEqual(fixture.taskStore.getTask(task.taskId), taskBefore);
      assert.deepEqual(workflow.readEvents().filter((event) => AgentEvents.message.queued.is(event)), queuedBefore);
      assert.equal(appServer.turnInputs.length, 0);
    } finally {
      await worker.stopAgent("test_cleanup");
      await coordinator.stopAgent("test_cleanup");
      backend.stop();
    }
  });
}

test("A terminal Phase outcome finishes its active Coordinator Step before entering idle runtime", async () => {
  let result: DynamicToolCallResponse | undefined;
  const appServer = createFakeAppServer({
    turnIds: ["turn-submit-terminal-phase", "turn-terminal-cleanup"],
    onRunTurn: async () => {
      if (appServer.turnInputs.length !== 1) return;
      assert.ok(appServer.handler);
      result = await appServer.handler({
        threadId: "thread-test", turnId: "turn-submit-terminal-phase",
        callId: "call-submit-terminal-phase", namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
        tool: "SubmitPhaseOutcome", arguments: { outcome: "completed" },
      });
      assert.equal(currentRunScope().workflow.snapshot()?.status, "settling");
      assert.equal(currentRunScope().workflow.snapshot()?.workflowId, "workflow-001");
      assert.match(agent.turn.workflow_phase(), /workflow_status: settling/);
      assert.match(agent.turn.workflow_phase(), /只完成旧工作收尾/);
    },
  });
  const scheduler = new Scheduler(new Graph(createGraphState({
    domain: "test",
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
  })));
  const fixture = createAgentFixture("submit-terminal-phase-outcome", { appServer, scheduler });
  const workflow = currentRunScope().workflow;
  const base = fixture.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(base instanceof BaseDomain);
  base.start();
  await fixture.eventBus.publishAndWait(RunEvents.runtime.attached, {
    mode: "start", attachedAt: new Date().toISOString(), processId: process.pid,
  });
  const oldPath = workflow.journalPath;
  const coordinatorAgent = new AgentBuilder().buildCoordinator();
  await coordinatorAgent.startThread();
  const backend = new AgentDynamicToolBackend();
  backend.start();

  try {
    assert.ok(appServer.handler);
    await new InteractionGateway().submitUserMessage({ messageId: "finish-phase", text: "Complete the final Phase." });
    await coordinatorAgent.runToIdle();

    assert.ok(result);
    assert.deepEqual(JSON.parse(result.contentItems[0]?.text ?? "{}"), {
      status: "accepted",
      currentPhase: "audit",
      cycleCompleted: true,
    });
    assert.equal(workflow.scheduler.snapshot().currentPhase, "audit");
    assert.equal(workflow.snapshot(), undefined);
    assert.equal(appServer.turnInputs.length, 1);
    assert.equal(readJournalEvents(oldPath).filter((event) => AgentEvents.turn.completed.is(event)).length, 1);
    assert.equal(workflow.readEvents().some((event) => AgentEvents.turn.started.is(event)), false);
  } finally {
    await coordinatorAgent.stopAgent("test_cleanup");
    backend.stop();
    base.stop();
  }
});

test("Coordinator does not carry phase or settlement scheduling into an idle runtime", async () => {
  let handleTool!: DynamicToolCallHandler;
  const outcomes: DynamicToolCallResponse[] = [];
  let turns = 0;
  const appServer = createFakeAppServer({
    turnIdForTurn: (_, index) => `turn-${index + 1}`,
    onRunTurn: async () => {
      if (++turns > 2) return;
      outcomes.push(await handleTool({
        threadId: "thread-test", turnId: `turn-${turns}`, callId: `finish-phase-${turns}`,
        namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE,
        tool: "SubmitPhaseOutcome", arguments: { outcome: "completed" },
      }));
    },
  });
  const scheduler = new Scheduler(new Graph(createGraphState({
    domain: "test", workflowProfile: "two-phase-test",
    phases: [
      { name: "research", edges: { completed: "audit", error: null }, roles: ["researcher"] },
      { name: "audit", edges: { completed: null, error: null }, roles: ["researcher"] },
    ],
    roles: [
      { name: "coordinator", phases: ["Synthesis"] },
      { name: "researcher", phases: ["research", "audit"] },
    ],
    currentPhase: "research",
  })));
  const fixture = createAgentFixture("coordinator-combined-phase-outcomes", { appServer, scheduler });
  const workflow = currentRunScope().workflow;
  const base = fixture.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(base instanceof BaseDomain);
  base.start();
  await fixture.eventBus.publishAndWait(RunEvents.runtime.attached, {
    mode: "start", attachedAt: new Date().toISOString(), processId: process.pid,
  });
  const oldPath = workflow.journalPath;
  const backend = new AgentDynamicToolBackend();
  backend.start();
  assert.ok(appServer.handler);
  handleTool = appServer.handler;
  const coordinator = new AgentBuilder().buildCoordinator();
  await coordinator.startThread();
  try {
    await new InteractionGateway().submitUserMessage({ messageId: "only-user", text: "Complete both Phases in their respective Steps." });
    await coordinator.runToIdle();
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes.every((response) => response.success), true);
    assert.deepEqual(outcomes.map((response) => JSON.parse(response.contentItems[0]?.text ?? "{}").cycleCompleted), [false, true]);
    assert.equal(workflow.snapshot(), undefined);
    assert.equal(appServer.turnInputs.length, 2, "completed Phase Turns must not start an empty next-Workflow Step");
    assert.equal(coordinator.pendingWorkflowInputs().length, 0);
    assert.equal(readJournalEvents(oldPath).filter((event) => AgentEvents.message.consumed.is(event)
      && event.payload.messageId === "only-user").length, 1);
    assert.equal(workflow.readEvents().some((event) => AgentEvents.turn.started.is(event)), false);
  } finally {
    await coordinator.stopAgent("test_cleanup");
    backend.stop();
    base.stop();
  }
});

test("WorkerAgent replaces restored failed and stopped tasks when new work arrives", async () => {
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
      description: "恢复仍绑定的终态任务",
      initialPrompt: agent.turn.message("恢复仍绑定的终态任务。"),
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
      description: "替换终态任务的新任务",
      phase: "research",
      prompt: agent.turn.message("替换终态任务的新任务。"),
    });

    assert.equal(assignment.ok, true);
    if (!assignment.ok) throw new Error("Expected restored terminal task to be replaced.");
    assert.equal(fixture.taskStore.getTask(task.taskId), undefined);
    assert.notEqual(worker.taskRunner?.snapshot().activeTask?.taskId, task.taskId);
    await worker.stopTask(assignment.value.taskId, "test_cleanup");
    await worker.runToIdle();
    await worker.releaseTask(assignment.value.taskId);
  }
});

test("AssignTask replaces a Done binding, serializes replacement, and preserves release history for restore", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("replace-done-binding", { appServer });
  const mount = createMount(fixture.root, "researcher");
  prepareAgent(fixture, "researcher", mount, createAssetCommit(mount));
  const builder = new AgentBuilder();
  const coordinator = builder.buildCoordinator();
  await coordinator.startThread();
  const worker = builder.buildWorker("researcher") as WorkerAgent;
  const now = new Date().toISOString();
  const oldTask: AgentTaskState = {
    type: "local_agent", taskId: "researcher-finished-task", taskSequence: 7,
    agentId: worker.agentId, role: worker.role, phase: "research",
    description: "Finished research", initialPrompt: agent.turn.message("Research."),
    status: AgentTaskStatuses.Done, isBackgrounded: true,
    stepIds: [], dispositions: [], createdAt: now, updatedAt: now,
  };
  worker.restoreTask({ task: oldTask, maxTaskSequence: 7 });
  await fixture.eventBus.publishAndWait(AgentEvents.task.assigned, oldTask);
  const oldRunner = worker.taskRunner;
  const backend = new AgentDynamicToolBackend();
  backend.start();
  let releaseStarted!: () => void;
  const releasing = new Promise<void>((resolve) => { releaseStarted = resolve; });
  let allowRelease!: () => void;
  const releaseGate = new Promise<void>((resolve) => { allowRelease = resolve; });
  const unsubscribe = fixture.eventBus.subscribe(AgentEvents.task.released, async () => {
    releaseStarted();
    await releaseGate;
  });
  try {
    assert.ok(appServer.handler);
    const call = {
      threadId: coordinator.threadId!, turnId: "replace-done", callId: "replace-done-1",
      namespace: AGENT_ASSIGN_TASK_TOOL_NAMESPACE, tool: "AssignTask",
      arguments: { description: "Next research", prompt: "Research the next target." },
    };
    const assignment = appServer.handler(call);
    await releasing;
    assert.equal(worker.taskRunner, oldRunner);
    assert.equal(worker.canAcceptTask(), false);
    const concurrent = await appServer.handler({ ...call, callId: "replace-done-2" });
    assert.equal(JSON.parse(concurrent.contentItems[0]?.text ?? "{}").status, "not_assigned");
    const message = await worker.sendMessage({ taskId: oldTask.taskId, message: agent.turn.message("Too late.") });
    assert.equal(message.ok, false);
    allowRelease();
    const assigned = await assignment;
    assert.equal(assigned.success, true);
    const response = JSON.parse(assigned.contentItems[0]?.text ?? "{}");
    assert.equal(response.status, "assigned");
    const task = fixture.taskStore.getTask(response.taskId);
    assert.equal(task?.taskSequence, 8);
    assert.equal(fixture.taskStore.getTask(oldTask.taskId), undefined);
    const events = fixture.journal.readAll();
    const released = events.filter((event) => AgentEvents.task.released.is(event));
    assert.equal(released.length, 1);
    assert.ok(AgentEvents.task.released.is(released[0]!));
    assert.equal(released[0].payload.status, AgentTaskStatuses.Done);
    const nextAssigned = events.find((event) => AgentEvents.task.assigned.is(event) && event.payload.taskId === task?.taskId);
    assert.ok(nextAssigned && nextAssigned.seq > released[0].seq);
  } finally {
    allowRelease();
    unsubscribe();
    await worker.stopAgent("test_cleanup");
    await coordinator.stopAgent("test_cleanup");
    backend.stop();
  }
});

for (const state of ["queued", "waiting-for-human", "pending-message", "in-flight-message"] as const) {
  test(`Worker cannot replace or release a Task with ${state}`, async () => {
    const fixture = createAgentFixture(`protect-${state}`);
    const mount = createMount(fixture.root, "researcher");
    prepareAgent(fixture, "researcher", mount, createAssetCommit(mount));
    const worker = new AgentBuilder().buildWorker("researcher") as WorkerAgent;
    const now = new Date().toISOString();
    const task: AgentTaskState = {
      type: "local_agent", taskId: "protected-task", taskSequence: 1,
      agentId: worker.agentId, role: worker.role, phase: "research",
      description: "Existing work", initialPrompt: agent.turn.message("Continue research."),
      status: state === "queued" ? AgentTaskStatuses.Queued
        : state === "waiting-for-human" ? AgentTaskStatuses.Running : AgentTaskStatuses.Done,
      isBackgrounded: true, stepIds: [],
      dispositions: state === "waiting-for-human" ? [{
        kind: AgentTaskDispositionKinds.WaitingForHuman, requestId: "human-request",
        stepId: "human-step", turnId: "human-turn", callId: "human-call",
        request: "Choose the target.", timestamp: now,
      }] : [],
      createdAt: now, updatedAt: now,
    };
    worker.restoreTask({ task, maxTaskSequence: 1 });
    const runner = worker.taskRunner;
    if (state === "pending-message") {
      worker.restoreMessages({ acceptedMessages: [], pendingMessages: [{
        messageId: "pending-correction", agentId: worker.agentId, taskId: task.taskId,
        body: agent.turn.message("Correct the evidence."), queuedAt: now,
      }] });
    }
    const delivery = state === "in-flight-message" ? worker.sendMessage({
      taskId: task.taskId, message: agent.turn.message("Correct the evidence."), deliveryMode: "queued",
    }) : undefined;
    // No await: the delivery has not reached the pending-message queue yet.
    assert.equal(worker.canAcceptTask(), false);
    const assignment = worker.assignTask({ description: "New work", phase: "research", prompt: agent.turn.message("Replace.") });
    const release = worker.releaseTask(task.taskId);
    assert.equal((await assignment).ok, false);
    await assert.rejects(release, /unfinished work or pending messages/);
    assert.equal(worker.taskRunner, runner);
    assert.equal(fixture.taskStore.listTasks().length, 1);
    assert.equal(fixture.journal.readAll().some((event) => AgentEvents.task.released.is(event)), false);
    await delivery;
    await worker.stopAgent("test_cleanup");
  });
}

test("Worker retains its old binding when resource release fails and can retry replacement", async () => {
  const fixture = createAgentFixture("release-failure-retry");
  const mount = createMount(fixture.root, "researcher");
  prepareAgent(fixture, "researcher", mount, createAssetCommit(mount));
  const worker = new AgentBuilder().buildWorker("researcher") as WorkerAgent;
  const now = new Date().toISOString();
  const task: AgentTaskState = {
    type: "local_agent", taskId: "old-task", taskSequence: 1,
    agentId: worker.agentId, role: worker.role, phase: "research",
    description: "Completed work", initialPrompt: agent.turn.message("Research."),
    status: AgentTaskStatuses.Done, isBackgrounded: true,
    stepIds: [], dispositions: [], createdAt: now, updatedAt: now,
  };
  worker.restoreTask({ task, maxTaskSequence: 1 });
  const runner = worker.taskRunner;
  const unsubscribe = fixture.eventBus.subscribe(AgentEvents.task.released, () => {
    throw new Error("release failed");
  }, { priority: EventSubscriptionPriorities.Critical });
  const input = { description: "Next task", phase: "research", prompt: agent.turn.message("Continue.") };
  try {
    await assert.rejects(worker.assignTask(input), /release failed/);
    assert.equal(worker.taskRunner, runner);
    assert.equal(fixture.taskStore.getTask(task.taskId)?.status, AgentTaskStatuses.Done);
    assert.equal(worker.canAcceptTask(), true);
    assert.equal(fixture.journal.readAll().some((event) => AgentEvents.task.released.is(event)), false);
    unsubscribe();
    const retry = await worker.assignTask(input);
    assert.ok(retry.ok);
    assert.equal(retry.value.taskSequence, 2);
    assert.equal(fixture.taskStore.getTask(task.taskId), undefined);
  } finally {
    unsubscribe();
    await worker.stopAgent("test_cleanup");
  }
});

test("RestoreTasksStage restores only bound Tasks and retains released sequence and result history", async () => {
  const fixture = createAgentFixture("restore-released-tasks");
  const base = fixture.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(base instanceof BaseDomain);
  base.start();
  const builder = new AgentBuilder();
  const workers = ["researcher", "verifier", "validator"].map((role) => {
    const mount = createMount(fixture.root, role);
    prepareAgent(fixture, role, mount, createAssetCommit(mount));
    return builder.buildWorker(role) as WorkerAgent;
  });
  const now = new Date().toISOString();
  const previous: AgentTaskState = {
    type: "local_agent", taskId: "released-research-task", taskSequence: 7,
    agentId: "researcher", role: "researcher", phase: "research",
    description: "Completed research", initialPrompt: agent.turn.message("Research."),
    status: AgentTaskStatuses.Done, isBackgrounded: true,
    stepIds: [], dispositions: [], createdAt: now, updatedAt: now,
  };
  const current = { ...previous, taskId: "current-research-task", taskSequence: 8 };
  const releasedVerifier = { ...previous, taskId: "released-verification-task", taskSequence: 12,
    agentId: "verifier", role: "verifier", phase: "verify", status: AgentTaskStatuses.Failed };
  try {
    await fixture.eventBus.publishAndWait(AgentEvents.task.assigned, previous);
    await fixture.eventBus.publishAndWait(AgentEvents.task.released, previous);
    await fixture.eventBus.publishAndWait(AgentEvents.task.assigned, current);
    await fixture.eventBus.publishAndWait(AgentEvents.task.assigned, releasedVerifier);
    await fixture.eventBus.publishAndWait(AgentEvents.task.released, releasedVerifier);
    await new RestoreTasksStage().start();
    const [researcher, verifier] = workers;
    assert.equal(researcher?.taskRunner?.snapshot().activeTask?.taskId, current.taskId);
    assert.equal(verifier?.taskRunner, undefined);
    assert.deepEqual(fixture.taskStore.listTasks().map((task) => task.taskId), [current.taskId]);
    const projection = projectRun(fixture.journal.readAll(), "coordinator");
    assert.deepEqual(projection.releasedTasks.map(({ task }) => [task.taskId, task.status]), [
      [previous.taskId, AgentTaskStatuses.Done], [releasedVerifier.taskId, AgentTaskStatuses.Failed],
    ]);
    const next = await verifier!.assignTask({ description: "New verification", phase: "verify", prompt: agent.turn.message("Verify.") });
    assert.ok(next.ok);
    assert.equal(next.value.taskSequence, 13);
  } finally {
    await Promise.all(workers.map((worker) => worker.stopAgent("test_cleanup")));
    base.stop();
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
    promptPreserved: appServer.turnInputs[0]?.prompt?.endsWith("check model profile"),
    model: appServer.turnInputs[0]?.model,
    reasoningEffort: appServer.turnInputs[0]?.reasoningEffort,
    reasoningSummary: appServer.turnInputs[0]?.reasoningSummary,
  }, {
    promptPreserved: true,
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

test("AgentTimelineBackend does not publish app-server agent message deltas as activity", () => {
  const appServer = createFakeAppServer();
  const domain = createStaticDomain("domain-skip-agent-message-delta", []);
  const fixture = createAgentFixture("skip-agent-message-delta", { appServer, domain });
  const activities: AgentActivity[] = [];
  fixture.eventBus.subscribe<AgentActivity>(AgentEvents.activity.observed, (event) => {
    activities.push(event.payload);
  });
  const registry = fixture.registry;
  new AgentTimelineBackend().start();
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

test("AgentTimelineBackend normalizes app-server items into Agent activity", () => {
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
  new AgentTimelineBackend().start();

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

test("AgentTimelineBackend publishes one command fact without the command result on completion", async () => {
  const entry = {
    seq: 11,
    stream: "item",
    kind: "item_completed",
    receivedAt: "2026-09-05T00:00:00.000Z",
    threadId: "thread-coordinator",
    turnId: "turn-command",
    itemId: "command-1",
  } satisfies AppServerTimelineEntry;
  const appServer = createFakeAppServer({
    resolveTimelineEntry: (resolvedEntry) => ({
      entry: resolvedEntry,
      item: {
        id: "command-1",
        type: "commandExecution",
        command: "jarvis ws schema call behavior-control",
        cwd: "/repo/mount",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "[RESULT] {\"status\":\"ok\"}",
        durationMs: 25,
      },
    }),
  });
  const fixture = createAgentFixture("agent-command-result", {
    appServer,
    domain: createStaticDomain("domain-command-result", []),
  });
  const coordinator = new CoordinatorAgent(fixture.options);
  fixture.registry.registerAgent(coordinator);
  fixture.registry.bindThread(coordinator.agentId, entry.threadId);
  const commands: AgentCommandExecutionObservedEvent[] = [];
  fixture.eventBus.subscribe(AgentEvents.commandExecution.observed, (event) => {
    if (AgentEvents.commandExecution.observed.is(event)) commands.push(event.payload);
  });
  new AgentTimelineBackend().start();

  appServer.emitTimeline(entry);
  await waitFor(() => commands.length === 1);

  assert.deepEqual(commands, [{
    sourceSeq: 11,
    agentId: "coordinator",
    role: "coordinator",
    threadId: "thread-coordinator",
    turnId: "turn-command",
    itemId: "command-1",
    command: "jarvis ws schema call behavior-control",
    cwd: "/repo/mount",
    status: "completed",
    exitCode: 0,
    durationMs: 25,
    observedAt: "2026-09-05T00:00:00.000Z",
  }]);
});

test("AgentTimelineBackend projects a failed command without its return value", async () => {
  const entry = {
    seq: 12,
    stream: "item",
    kind: "item_completed",
    receivedAt: "2026-09-05T00:00:01.000Z",
    threadId: "thread-coordinator",
    turnId: "turn-command",
    itemId: "command-2",
  } satisfies AppServerTimelineEntry;
  const appServer = createFakeAppServer({
    resolveTimelineEntry: (resolvedEntry) => ({
      entry: resolvedEntry,
      item: {
        id: "command-2",
        type: "commandExecution",
        command: "ls /restricted",
        cwd: "/repo/mount",
        status: "completed",
        exitCode: 1,
        aggregatedOutput: `ls: /restricted: Operation not permitted ${"x".repeat(300)}`,
        durationMs: 10,
      },
      progressItem: {
        itemId: "command-2",
        threadId: "thread-coordinator",
        turnId: "turn-command",
        type: "commandExecution",
        status: "completed",
        label: "ls /restricted",
        detail: "/repo/mount",
        item: {
          id: "command-2",
          type: "commandExecution",
          command: "ls /restricted",
          cwd: "/repo/mount",
          status: "completed",
          exitCode: 1,
          aggregatedOutput: `ls: /restricted: Operation not permitted ${"x".repeat(300)}`,
          durationMs: 10,
        },
        updatedAt: "2026-09-05T00:00:01.000Z",
      },
    }),
  });
  const fixture = createAgentFixture("agent-command-activity-failure", {
    appServer,
    domain: createStaticDomain("domain-command-activity-failure", []),
  });
  const coordinator = new CoordinatorAgent(fixture.options);
  fixture.registry.registerAgent(coordinator);
  fixture.registry.bindThread(coordinator.agentId, entry.threadId);
  const activities: AgentActivity[] = [];
  const commands: AgentCommandExecutionObservedEvent[] = [];
  fixture.eventBus.subscribe(AgentEvents.activity.observed, (event) => {
    if (AgentEvents.activity.observed.is(event)) activities.push(event.payload);
  });
  fixture.eventBus.subscribe(AgentEvents.commandExecution.observed, (event) => {
    if (AgentEvents.commandExecution.observed.is(event)) commands.push(event.payload);
  });
  new AgentTimelineBackend().start();

  appServer.emitTimeline(entry);
  await waitFor(() => commands.length === 1);

  assert.equal(activities.length, 0);
  assert.equal(commands[0]?.status, "completed");
  assert.equal(commands[0]?.exitCode, 1);
  assert.equal(Object.hasOwn(commands[0] ?? {}, "aggregatedOutput"), false);
});

test("AgentTimelineBackend keeps command bodies out of Activity facts", async () => {
  const entry = {
    seq: 13,
    stream: "item",
    kind: "item_completed",
    receivedAt: "2026-09-05T00:00:02.000Z",
    threadId: "thread-coordinator",
    turnId: "turn-command",
    itemId: "command-3",
  } satisfies AppServerTimelineEntry;
  const command = [
    "/bin/zsh -lc 'cat > ../artifacts/execution-pack.md <<'\"'\"'EOF'\"'\"'",
    "# RBT Execution Pack",
    "private artifact body",
    "EOF'",
  ].join("\n");
  const item = {
    id: "command-3",
    type: "commandExecution" as const,
    command,
    cwd: "/repo/mount",
    status: "completed",
    exitCode: 0,
    aggregatedOutput: "",
    durationMs: 10,
  };
  const appServer = createFakeAppServer({
    resolveTimelineEntry: (resolvedEntry) => ({
      entry: resolvedEntry,
      item,
      progressItem: {
        itemId: item.id,
        threadId: "thread-coordinator",
        turnId: "turn-command",
        type: "commandExecution",
        status: item.status,
        label: item.command,
        detail: item.cwd,
        item,
        updatedAt: entry.receivedAt,
      },
    }),
  });
  const fixture = createAgentFixture("agent-command-activity-heredoc", {
    appServer,
    domain: createStaticDomain("domain-command-activity-heredoc", []),
  });
  const coordinator = new CoordinatorAgent(fixture.options);
  fixture.registry.registerAgent(coordinator);
  fixture.registry.bindThread(coordinator.agentId, entry.threadId);
  const activities: AgentActivity[] = [];
  const commands: AgentCommandExecutionObservedEvent[] = [];
  fixture.eventBus.subscribe(AgentEvents.activity.observed, (event) => {
    if (AgentEvents.activity.observed.is(event)) activities.push(event.payload);
  });
  fixture.eventBus.subscribe(AgentEvents.commandExecution.observed, (event) => {
    if (AgentEvents.commandExecution.observed.is(event)) commands.push(event.payload);
  });
  new AgentTimelineBackend().start();

  appServer.emitTimeline(entry);
  await waitFor(() => commands.length === 1);

  assert.equal(activities.length, 0);
  assert.match(commands[0]?.command ?? "", /RBT Execution Pack|private artifact body/);
  assert.equal(Object.hasOwn(commands[0] ?? {}, "aggregatedOutput"), false);
});

test("AgentTimelineBackend publishes context compaction as ordinary activity", () => {
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
  new AgentTimelineBackend().start();

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

test("AgentTimelineBackend publishes native subagent facts without activity duplication", () => {
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
  const nativeSubagentActivities: AgentNativeSubagentEvent[] = [];
  fixture.eventBus.subscribe<AgentActivity>(AgentEvents.activity.observed, (event) => {
    activities.push(event.payload);
  });
  fixture.eventBus.subscribe<AgentNativeSubagentEvent>(
    AgentEvents.subagent.observed,
    (event) => {
      nativeSubagentActivities.push(event.payload);
    },
  );
  new AgentTimelineBackend().start();

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
  assert.equal(activities.length, 0);
});

test("AgentTimelineBackend publishes turn lifecycle separately from item activity", () => {
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
  new AgentTimelineBackend().start();

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

test("AgentTimelineBackend logs only health failures from an unbound app-server event burst", () => {
  const appServer = createFakeAppServer();
  const logs: Array<Omit<LogEvent, "timestamp" | "level" | "runId"> & { level: string }> = [];
  const logger = createCaptureLogger(logs);
  const fixture = createAgentFixture("app-server-log-volume", {
    appServer,
    domain: createStaticDomain("domain-app-server-log-volume", []),
    logger,
  });
  new AgentTimelineBackend().start();

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

test("Timeline and Dynamic Tool backends own independent subscription lifetimes", () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("agent-backend-stop", {
    appServer,
    domain: createStaticDomain("domain-agent-backend-stop", []),
  });
  const backend = new AgentTimelineBackend();

  backend.start();
  assert.equal(appServer.handler, undefined);
  assert.equal(appServer.timelineHandlerCount, 1);
  const dynamicTool = new AgentDynamicToolBackend();
  dynamicTool.start();
  assert.ok(appServer.handler);

  backend.stop();
  backend.stop();
  assert.equal(appServer.timelineHandlerCount, 0);
  assert.ok(appServer.handler);
  dynamicTool.stop();
  dynamicTool.stop();
  assert.equal(appServer.handler, undefined);
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
    description: { id: ScoutDomainId.Validation, name: "domain-child-tool" },
    backend: new class extends DomainAgentBackend {
      override dynamicToolsForPhase() { return [buildDomainTool("domain-child-tool")]; }

      override async handleDynamicToolCall(call: ScoutDomainDynamicToolCall): Promise<DynamicToolCallResponse> {
        calls.push(call);
        return {
          success: true,
          contentItems: [{ type: "inputText", text: "domain result" }],
        };
      }
    }(),
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
  new AgentDynamicToolBackend().start();
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

test("AgentDynamicToolBackend passes the current Workflow Phase to a Domain tool call", async () => {
  const calls: ScoutDomainDynamicToolCall[] = [];
  const appServer = createFakeAppServer();
  const domain: ScoutDomain = {
    description: { id: ScoutDomainId.Validation, name: "domain-phase-call" },
    backend: new class extends DomainAgentBackend {
      override dynamicToolsForPhase() { return [buildDomainTool("domain-phase-call")]; }

      override async handleDynamicToolCall(call: ScoutDomainDynamicToolCall): Promise<DynamicToolCallResponse> {
        calls.push(call);
        return {
          success: true,
          contentItems: [{ type: "inputText", text: "domain result" }],
        };
      }
    }(),
  };
  const fixture = createAgentFixture("worker-domain-phase-call", { appServer, domain });
  const researcherMount = createMount(fixture.root, "researcher");
  prepareAgent(
    fixture,
    "researcher",
    researcherMount,
    createAssetCommit(researcherMount),
  );
  const researcher = new AgentBuilder().buildWorker("researcher");
  new AgentDynamicToolBackend().start();
  await researcher.startThread();

  assert.ok(appServer.handler);
  const result = await appServer.handler({
    threadId: researcher.threadId ?? "",
    turnId: "turn-domain-phase-call",
    callId: "call-domain-phase-call",
    namespace: "domain-phase-call",
    tool: "DomainProbe",
    arguments: {},
  });

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.caller.phase, "research");
});

test("AgentDynamicToolBackend routes tools across every registered Scout Domain", async () => {
  const calls: ScoutDomainDynamicToolCall[] = [];
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("worker-multiple-domain-tools", { appServer });
  fixture.domainRegistry.register({
    description: { id: ScoutDomainId.Rbt, name: "secondary-domain" },
    backend: new class extends DomainAgentBackend {
      override dynamicToolsForPhase() { return [buildDomainTool("secondary-domain")]; }

      override async handleDynamicToolCall(call: ScoutDomainDynamicToolCall): Promise<DynamicToolCallResponse> {
        calls.push(call);
        return {
          success: true,
          contentItems: [{ type: "inputText", text: "secondary domain result" }],
        };
      }
    }(),
  });
  const researcherMount = createMount(fixture.root, "researcher");
  prepareAgent(
    fixture,
    "researcher",
    researcherMount,
    createAssetCommit(researcherMount),
  );
  const researcher = new AgentBuilder().buildWorker("researcher");
  new AgentDynamicToolBackend().start();
  await researcher.startThread();

  assert.ok(researcher.spec.dynamicTools?.some((tool) =>
    tool.namespace === "secondary-domain" && tool.name === "DomainProbe"
  ));
  assert.ok(appServer.handler);
  const result = await appServer.handler({
    threadId: researcher.threadId ?? "",
    turnId: "turn-secondary-domain-call",
    callId: "call-secondary-domain-call",
    namespace: "secondary-domain",
    tool: "DomainProbe",
    arguments: {},
  });

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.caller.phase, "research");
});

test("AgentDynamicToolBackend rejects duplicate Domain backend registrations before invoking either tool", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("duplicate-domain-backends", { appServer });
  const calls: ScoutDomainDynamicToolCall[] = [];
  const definition = buildDomainTool("duplicate-domain-tool");
  assert.ok(definition.namespace);
  for (const id of [ScoutDomainId.Validation, ScoutDomainId.Rbt]) {
    const backend = new class extends DomainAgentBackend {
      override async handleDynamicToolCall(call: ScoutDomainDynamicToolCall) {
        calls.push(call);
        return undefined;
      }
    }();
    if (id === ScoutDomainId.Validation) {
      fixture.domainRegistry.unregister(fixture.domainRegistry.get(id));
    }
    fixture.domainRegistry.register({ description: { id, name: id }, backend });
    backend.register("research", {
      definition,
      tool: { execute: async () => ({ success: true, contentItems: [] }) },
    });
  }
  const mount = createMount(fixture.root, "researcher");
  prepareAgent(fixture, "researcher", mount, createAssetCommit(mount));
  const researcher = new AgentBuilder().buildWorker("researcher");
  new AgentDynamicToolBackend().start();
  await researcher.startThread();
  assert.ok(appServer.handler);
  const response = await appServer.handler({
    threadId: researcher.threadId ?? "",
    turnId: "turn-duplicate-domain-call",
    callId: "call-duplicate-domain-call",
    namespace: definition.namespace,
    tool: definition.name,
    arguments: {},
  });
  assert.equal(response.success, false);
  assert.match(response.contentItems[0]?.text ?? "", /registered by multiple Scout Domains: validation, rbt/);
  assert.deepEqual(calls, []);
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
  new AgentDynamicToolBackend().start();
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
  new AgentDynamicToolBackend().start();

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
  new AgentDynamicToolBackend().start();
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
  new AgentDynamicToolBackend().start();
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

for (const result of [
  { status: "completed", finalResponse: "Workflow finished." },
  { status: "completed", finalResponse: "" },
  { status: "failed", finalResponse: "Unfinished response." },
  { status: "interrupted", finalResponse: "Interrupted response." },
] as const) {
  test(result.status === "interrupted"
    ? "Coordinator retains an interrupted terminal tick for old-Workflow recovery"
    : `Coordinator enters an idle runtime after its terminal ${result.status} tick (${result.finalResponse || "no response"}) settles`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const terminal = new Promise<void>((resolve) => { entered = resolve; });
    const appServer = createFakeAppServer({
      turnStatus: result.status,
      finalResponse: result.finalResponse,
      onRunTurn: async () => {
        const workflow = currentRunScope().workflow;
        assert.equal(workflow.scheduler.advance("error").cycleCompleted, true);
        entered();
        await gate;
      },
    });
    const fixture = createAgentFixture(`coordinator-workflow-${result.status}`, { appServer });
    const scope = currentRunScope();
    const workflow = scope.workflow;
    workflow.initialize();
    const base = fixture.domainRegistry.get(ScoutDomainId.Base);
    assert.ok(base instanceof BaseDomain);
    base.start();
    await fixture.eventBus.publishAndWait(RunEvents.runtime.attached, {
      mode: "start", attachedAt: new Date().toISOString(), processId: process.pid,
    });
    const oldPath = workflow.journalPath;
    const coordinator = new AgentBuilder().buildCoordinator();
    await coordinator.startThread();
    const gateway = new InteractionGateway();
    try {
      await gateway.submitUserMessage({ text: "Finish this Workflow.", messageId: "finish-workflow" });
      await waitFor(() => appServer.turnInputs.length === 1);
      await terminal;
      assert.equal(workflow.snapshot()?.workflowId, "workflow-001");
      assert.equal(workflow.snapshot()?.status, "settling");
      release();
      await coordinator.runToIdle();
      if (result.status === "interrupted") {
        assert.equal(workflow.snapshot()?.workflowId, "workflow-001");
        assert.equal(workflow.snapshot()?.status, "settling");
        const retained = readJournalEvents(oldPath);
        assert.equal(retained.filter((event) => AgentEvents.step.interrupted.is(event)).length, 1);
        assert.equal(retained.filter((event) => AgentEvents.turn.completed.is(event)
          && event.payload.turn.status === "interrupted").length, 1);
        assert.equal(retained.filter((event) => AgentEvents.message.consumed.is(event)
          && event.payload.messageId === "finish-workflow").length, 1);
        assert.equal(retained.some((event) => WorkflowEvents.workflow.completed.is(event)), false);
        assert.equal(retained.some((event) => AgentEvents.coordinator.messageProduced.is(event)
          && event.payload.text === result.finalResponse), false);
        assert.equal(appServer.turnInputs.length, 1, "direct graph advancement does not request a cleanup Step");
        return;
      }
      assert.equal(workflow.snapshot(), undefined);
      const oldEvents = readJournalEvents(oldPath);
      assert.equal(oldEvents.filter((event) => AgentEvents.turn.completed.is(event)).length, 1);
      assert.equal(oldEvents.filter((event) => AgentEvents.message.consumed.is(event)).length, 1);
      const responses = oldEvents.filter((event) => AgentEvents.coordinator.messageProduced.is(event));
      assert.equal(responses.length, result.status === "completed" && result.finalResponse ? 1 : 0);
      assert.equal(workflow.readEvents().some((event) => AgentEvents.turn.completed.is(event)
        || AgentEvents.coordinator.messageProduced.is(event)), false);
      assert.equal(appServer.turnInputs.length, 1, "no extra input or automatic Agent turn starts the Workflow");
      assert.equal(coordinator.threadSnapshot?.threadId, "thread-test");
    } finally {
      release();
      await coordinator.stopAgent("test_cleanup");
      base.stop();
    }
  });
}

test("Coordinator consumes Gateway input even when ScoutJournal cannot record that input", async (t) => {
  const appServer = createFakeAppServer({ finalResponse: "Received without depending on the journal." });
  const fixture = createAgentFixture("coordinator-input-journal-failure", { appServer });
  const workflow = currentRunScope().workflow;
  workflow.initialize();
  const coordinator = new AgentBuilder().buildCoordinator();
  await coordinator.startThread();
  const failures: ScoutEvent[] = [];
  fixture.eventBus.subscribe(RunEvents.journal.writeFailed, (event) => { failures.push(event); });
  const original = Journal.prototype.append;
  t.mock.method(Journal.prototype, "append", function (this: Journal, event: ScoutEvent) {
    if (this.path === workflow.journalPath && SystemEvents.interaction.userMessageSubmitted.is(event)) {
      throw new Error("input recording unavailable");
    }
    return original.call(this, event);
  });
  try {
    await new InteractionGateway().submitUserMessage({ text: "Keep consuming.", messageId: "independent-input" });
    await coordinator.runToIdle();
    assert.equal(appServer.turnInputs.length, 1);
    assert.match(appServer.turnInputs[0]!.prompt ?? "", /Keep consuming\./);
    assert.equal(failures.length, 1);
    const events = workflow.readEvents();
    assert.equal(events.some((event) => SystemEvents.interaction.userMessageSubmitted.is(event)), false);
    assert.equal(events.some((event) => AgentEvents.message.consumed.is(event)
      && event.payload.messageId === "independent-input"), true);
    assert.equal(events.some((event) => AgentEvents.coordinator.messageProduced.is(event)), true);
  } finally {
    await coordinator.stopAgent("test_cleanup");
  }
});

for (const failOldRawInput of [false, true]) {
  test(`Coordinator consumes accepted unconsumed input with no active Workflow${failOldRawInput ? " when the old raw input write fails" : " in original order"}`, async (t) => {
    let enterFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { enterFirst = resolve; });
    let finishFirst!: () => void;
    const finishRequested = new Promise<void>((resolve) => { finishFirst = resolve; });
    let enterTerminal!: () => void;
    const terminalEntered = new Promise<void>((resolve) => { enterTerminal = resolve; });
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    let handleTool!: DynamicToolCallHandler;
    let terminalResponse: DynamicToolCallResponse | undefined;
    let turns = 0;
    const appServer = createFakeAppServer({
      turnIds: ["turn-first-workflow", "turn-next-workflow"],
      onRunTurn: async () => {
        if (++turns !== 1) return;
        enterFirst();
        await finishRequested;
        terminalResponse = await handleTool({
          threadId: "thread-test", turnId: "turn-first-workflow", callId: "finish-first-workflow",
          namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE, tool: "SubmitPhaseOutcome", arguments: { outcome: "error" },
        });
        enterTerminal();
        await terminalGate;
      },
    });
    const fixture = createAgentFixture(`coordinator-pending-input-${failOldRawInput}`, { appServer });
    const workflow = currentRunScope().workflow;
    const base = fixture.domainRegistry.get(ScoutDomainId.Base);
    assert.ok(base instanceof BaseDomain);
    base.start();
    await fixture.eventBus.publishAndWait(RunEvents.runtime.attached, {
      mode: "start", attachedAt: new Date().toISOString(), processId: process.pid,
    });
    const backend = new AgentDynamicToolBackend();
    backend.start();
    assert.ok(appServer.handler);
    handleTool = appServer.handler;
    const coordinator = new AgentBuilder().buildCoordinator();
    await coordinator.startThread();
    const oldPath = workflow.journalPath;
    const failures: ScoutEvent[] = [];
    fixture.eventBus.subscribe(RunEvents.journal.writeFailed, (event) => { failures.push(event); });
    const originalAppend = Journal.prototype.append;
    t.mock.method(Journal.prototype, "append", function (this: Journal, event: ScoutEvent) {
      if (failOldRawInput && this.path === oldPath
        && SystemEvents.interaction.userMessageSubmitted.is(event) && event.payload.messageId === "next-user-2") {
        throw new Error("old Workflow raw user recording failed");
      }
      return originalAppend.call(this, event);
    });
    try {
      const gateway = new InteractionGateway();
      await gateway.submitUserMessage({ messageId: "first-user", text: "Finish the original work." });
      await waitFor(() => appServer.turnInputs.length === 1);
      await firstStarted;
      await gateway.submitUserMessage({ messageId: "next-user-2", text: "Second user input for the next Workflow.", source: "test-user", data: { position: 2 } });
      await gateway.submitUserMessage({ messageId: "next-user-3", text: "Third user input for the next Workflow.", source: "test-user", data: { position: 3 } });
      await coordinator.drainInput();
      const pending = coordinator.pendingWorkflowInputs();
      assert.deepEqual(pending.map(({ delivery }) => delivery.messageId), ["next-user-2", "next-user-3"]);
      assert.equal(appServer.turnInputs.length, 1, "accepted input must not start a concurrent Coordinator Step");
      const beforeBoundary = workflow.readEvents();
      assert.equal(beforeBoundary.some((event) => AgentEvents.message.consumed.is(event)
        && event.payload.messageId === "next-user-2"), false);
      assert.equal(beforeBoundary.filter((event) => AgentEvents.message.queued.is(event)
        && event.payload.messageId === "next-user-2").length, 1);
      assert.equal(beforeBoundary.some((event) => SystemEvents.interaction.userMessageSubmitted.is(event)
        && event.payload.messageId === "next-user-2"), !failOldRawInput);
      assert.equal(failures.length, failOldRawInput ? 1 : 0);
      finishFirst();
      await terminalEntered;
      assert.equal(terminalResponse?.success, true);
      assert.equal(workflow.snapshot()?.workflowId, "workflow-001");
      assert.equal(workflow.snapshot()?.status, "settling");
      releaseTerminal();
      await coordinator.runToIdle();
      assert.equal(workflow.snapshot(), undefined);
      assert.equal(appServer.turnInputs.length, 2);
      const nextPrompt = appServer.turnInputs[1]!.prompt ?? "";
      assert.doesNotMatch(appServer.turnInputs[0]!.prompt ?? "", /Second user input|Third user input/);
      assert.ok(nextPrompt.indexOf("Second user input") >= 0);
      assert.ok(nextPrompt.indexOf("Third user input") > nextPrompt.indexOf("Second user input"));
      const nextEvents = workflow.readEvents();
      const oldEvents = readJournalEvents(oldPath);
      assert.deepEqual(nextEvents, []);
      assert.match(nextPrompt, /workflow_status: empty/);
      for (const { delivery } of pending) {
        assert.equal(oldEvents.filter((event) => AgentEvents.message.consumed.is(event)
          && event.payload.messageId === delivery.messageId).length, 0);
      }
      assert.equal(coordinator.pendingWorkflowInputs().length, 0);
      assert.equal(oldEvents.filter((event) => AgentEvents.message.consumed.is(event)
        && event.payload.messageId === "first-user").length, 1);
    } finally {
      finishFirst();
      releaseTerminal();
      await coordinator.stopAgent("test_cleanup");
      backend.stop();
      base.stop();
    }
  });
}

for (const outcome of ["completed", "error"] as const) {
test(`Workflow ${outcome} automatically releases finished Worker tasks before consuming pending input with no active Workflow`, async () => {
  let finishFirst!: () => void;
  const finishRequested = new Promise<void>((resolve) => { finishFirst = resolve; });
  let enterRelease!: () => void;
  const releaseStarted = new Promise<void>((resolve) => { enterRelease = resolve; });
  let finishRelease!: () => void;
  const releaseGate = new Promise<void>((resolve) => { finishRelease = resolve; });
  let handleTool!: DynamicToolCallHandler;
  let terminalResponse: DynamicToolCallResponse | undefined;
  let turns = 0;
  const appServer = createFakeAppServer({
    threadIds: ["thread-coordinator", "thread-researcher", "thread-verifier"],
    turnIds: ["turn-original", "turn-next-input"],
    onRunTurn: async () => {
      if (++turns === 1) {
        await finishRequested;
        terminalResponse = await handleTool({
          threadId: "thread-coordinator", turnId: "turn-original", callId: "terminal-with-finished-tasks",
          namespace: AGENT_SUBMIT_PHASE_OUTCOME_TOOL_NAMESPACE, tool: "SubmitPhaseOutcome", arguments: { outcome },
        });
      }
    },
  });
  const graph = createTestScheduler().snapshot();
  const fixture = createAgentFixture(`coordinator-terminal-release-${outcome}`, {
    appServer, scheduler: new Scheduler(new Graph({
      ...graph,
      phases: graph.phases.map((phase, index) => index === 0
        ? { ...phase, edges: { ...phase.edges, completed: null } } : phase),
    })),
  });
  const workflow = currentRunScope().workflow;
  const base = fixture.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(base instanceof BaseDomain);
  base.start();
  await fixture.eventBus.publishAndWait(RunEvents.runtime.attached, {
    mode: "start", attachedAt: new Date().toISOString(), processId: process.pid,
  });
  const backend = new AgentDynamicToolBackend();
  backend.start();
  assert.ok(appServer.handler);
  handleTool = appServer.handler;
  const builder = new AgentBuilder();
  const coordinator = builder.buildCoordinator();
  await coordinator.startThread();
  const workers: WorkerAgent[] = [];
  const now = new Date().toISOString();
  for (const role of ["researcher", "verifier"]) {
    const mount = createMount(fixture.root, role);
    prepareAgent(fixture, role, mount, createAssetCommit(mount));
    const worker = builder.buildWorker(role);
    assert.ok(worker instanceof WorkerAgent);
    await worker.startThread();
    const task: AgentTaskState = {
      type: "local_agent", taskId: role + "-finished-task", taskSequence: 1,
      agentId: worker.agentId, role, phase: "research",
      description: "Completed old Workflow work", initialPrompt: "Old work", status: AgentTaskStatuses.Done,
      isBackgrounded: true, stepIds: [], dispositions: [], createdAt: now, updatedAt: now, finishedAt: now,
    };
    worker.restoreTask({ task, maxTaskSequence: 1 });
    await fixture.eventBus.publishAndWait(AgentEvents.task.assigned, task, { occurredAt: now });
    workers.push(worker);
  }
  const unsubscribe = fixture.eventBus.subscribe(AgentEvents.task.released, async () => {
    enterRelease();
    await releaseGate;
  });
  const oldPath = workflow.journalPath;
  try {
    const gateway = new InteractionGateway();
    await gateway.submitUserMessage({ messageId: "original-user", text: "Conclude the original Workflow." });
    await waitFor(() => appServer.turnInputs.length === 1);
    await gateway.submitUserMessage({ messageId: "next-workflow-user", text: "NEXT WORKFLOW ONLY USER INPUT" });
    await coordinator.drainInput();
    finishFirst();
    await releaseStarted;
    assert.equal(terminalResponse?.success, true);
    assert.equal(workflow.snapshot()?.status, "settling");
    assert.equal(appServer.turnInputs.length, 1, "resource cleanup does not need another Agent turn");
    assert.equal(coordinator.pendingWorkflowInputs().length, 1);
    finishRelease();
    await coordinator.runToIdle();
    assert.equal(fixture.taskStore.listTasks().length, 0);
    assert.ok(workers.every((worker) => worker.taskRunner === undefined));
    assert.equal(workflow.snapshot(), undefined);
    assert.equal(new ScoutBenchmarks(new Benchmarks(currentRunScope().runRoot)).read()?.lastSuccess,
      outcome === "completed" ? "workflow-001" : undefined);
    assert.equal(appServer.turnInputs.length, 2);
    assert.match(appServer.turnInputs[1]!.prompt ?? "", /NEXT WORKFLOW ONLY USER INPUT/);
    const oldEvents = readJournalEvents(oldPath);
    const releases = oldEvents.filter((event) => AgentEvents.task.released.is(event));
    assert.equal(releases.length, 2);
    assert.ok(releases.every((event) => AgentEvents.task.released.is(event) && event.payload.status === "done"));
    const completed = oldEvents.find((event) => WorkflowEvents.workflow.completed.is(event));
    assert.ok(completed);
    assert.ok(releases.every((event) => event.seq < completed.seq));
    assert.equal(oldEvents.some((event) => AgentEvents.message.consumed.is(event)
      && event.payload.messageId === "next-workflow-user"), false);
    assert.equal(workflow.readEvents().filter((event) => AgentEvents.message.consumed.is(event)
      && event.payload.messageId === "next-workflow-user").length, 0);
    assert.match(appServer.turnInputs[1]!.prompt ?? "", /workflow_status: empty/);
    assert.equal(oldEvents.some((event) => AgentEvents.coordinator.messageProduced.is(event)
      && event.payload.text.includes("Coordinator turn failed")), false);
  } finally {
    finishFirst();
    finishRelease();
    unsubscribe();
    await Promise.all([coordinator.stopAgent("test_cleanup"), ...workers.map((worker) => worker.stopAgent("test_cleanup"))]);
    backend.stop();
    base.stop();
  }
});
}

test("A failed Worker release retains the settling Workflow and retries without losing its journal", async (t) => {
  const appServer = createFakeAppServer({ threadIds: ["thread-researcher", "thread-verifier"] });
  const graph = createTestScheduler().snapshot();
  const fixture = createAgentFixture("workflow-release-failure", {
    appServer, scheduler: new Scheduler(new Graph({
      ...graph,
      phases: graph.phases.map((phase, index) => index === 0
        ? { ...phase, edges: { ...phase.edges, completed: null } } : phase),
    })),
  });
  const workflow = currentRunScope().workflow;
  const base = fixture.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(base instanceof BaseDomain);
  base.start();
  await fixture.eventBus.publishAndWait(RunEvents.runtime.attached, {
    mode: "start", attachedAt: new Date().toISOString(), processId: process.pid,
  });
  const builder = new AgentBuilder();
  const workers: WorkerAgent[] = [];
  const now = new Date().toISOString();
  for (const role of ["researcher", "verifier"]) {
    const mount = createMount(fixture.root, role);
    prepareAgent(fixture, role, mount, createAssetCommit(mount));
    const worker = builder.buildWorker(role) as WorkerAgent;
    await worker.startThread();
    const task: AgentTaskState = {
      type: "local_agent", taskId: role + "-finished", taskSequence: 1,
      agentId: role, role, phase: "research", description: "Completed work",
      initialPrompt: agent.turn.message("Research."), status: AgentTaskStatuses.Done,
      isBackgrounded: true, stepIds: [], dispositions: [], createdAt: now, updatedAt: now,
    };
    worker.restoreTask({ task, maxTaskSequence: 1 });
    await fixture.eventBus.publishAndWait(AgentEvents.task.assigned, task);
    workers.push(worker);
  }
  const failed = t.mock.method(workers[1]!, "releaseTask", async () => { throw new Error("Worker release failed"); });
  const oldPath = workflow.journalPath;
  try {
    workflow.scheduler.advance("completed");
    const before = new ScoutBenchmarks(new Benchmarks(currentRunScope().runRoot)).read();
    await assert.rejects(workflow.settleWorkflow(), /Worker release failed/);
    assert.equal(workflow.snapshot()?.status, "settling");
    assert.equal(workflow.journalPath, oldPath);
    assert.deepEqual(new ScoutBenchmarks(new Benchmarks(currentRunScope().runRoot)).read(), before);
    assert.equal(workflow.readEvents().some((event) => WorkflowEvents.workflow.completed.is(event)), false);
    assert.equal(workers[0]?.taskRunner, undefined);
    assert.ok(workers[1]?.taskRunner);
    failed.mock.restore();
    await workflow.settleWorkflow();
    assert.equal(workflow.snapshot(), undefined);
    assert.equal(new ScoutBenchmarks(new Benchmarks(currentRunScope().runRoot)).read()?.lastSuccess, "workflow-001");
    const oldEvents = readJournalEvents(oldPath);
    assert.equal(oldEvents.filter((event) => AgentEvents.task.released.is(event)).length, 2);
    assert.equal(oldEvents.filter((event) => WorkflowEvents.workflow.completed.is(event)).length, 1);
  } finally {
    failed.mock.restore();
    await Promise.all(workers.map((worker) => worker.stopAgent("test_cleanup")));
    base.stop();
  }
});

for (const Stage of [AgentsStage, RestoreAgentsStage]) {
  test(`${Stage.name} closes input and waits for accepted dispatch before stopping Agents`, async (t) => {
    const fixture = createAgentFixture(`drain-before-${Stage.name}`);
    const coordinator = new AgentBuilder().buildCoordinator();
    await coordinator.startThread();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fixture.eventBus.subscribe(SystemEvents.interaction.userMessageSubmitted, () => gate, {
      priority: EventSubscriptionPriorities.Critical,
    });
    let delivered = false;
    fixture.eventBus.subscribe(SystemEvents.interaction.userMessageSubmitted, () => { delivered = true; });
    const original = coordinator.stopAgent.bind(coordinator);
    const stoppingAgent = t.mock.method(coordinator, "stopAgent", async (reason: string) => {
      assert.equal(delivered, true);
      await original(reason);
    });
    const gateway = new InteractionGateway();
    const accepted = gateway.submitUserMessage({ text: "Admitted before stop.", messageId: "accepted-before-stop" });
    const stage = new Stage();
    const stopping = stage.stop("test_shutdown");
    try {
      await assert.rejects(gateway.submitUserMessage({ text: "Too late." }), /Workflow is stopping/);
      assert.equal(stoppingAgent.mock.callCount(), 0);
      release();
      await Promise.all([accepted, stopping]);
      assert.equal(stoppingAgent.mock.callCount(), 1);
      assert.equal(coordinator.threadSnapshot?.status, "closed");
      assert.equal(fixture.journal.readAll().some((event) => AgentEvents.message.queued.is(event)
        && event.payload.messageId === "accepted-before-stop"), true);
    } finally {
      release();
      await Promise.allSettled([accepted, stopping]);
    }
  });
}

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
      if (prompt.includes("response:\nUse staging account.\n</human-response>")) {
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
            outcome: `## Outcome\n\n- Artifact: ${currentRunScope().workflow.agentPaths("verifier").artifactRoot}/result.md`,
          },
        });
        submitSucceeded = result.success;
      }
    },
  });
  const domain = createStaticDomain("domain-worker-lifecycle-tools", []);
  const fixture = createAgentFixture("worker-lifecycle-tools", {
    appServer, domain,
    scheduler: new Scheduler(new Graph({ ...createTestScheduler().snapshot(), currentPhase: "verify" })),
  });
  const verifierMount = createMount(fixture.root, "verifier");
  const verifierCommit = createAssetCommit(verifierMount);
  new AgentDynamicToolBackend().start();
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
      "<task-outcome>\n## Outcome\n\n- Artifact: scout-artifact://workflow-001/verifier/result.md\n</task-outcome>",
    )
  ));
  const handoffTurn = appServer.turnInputs.find((turn) => turn.prompt?.includes(
    "<task-outcome>\n## Outcome\n\n- Artifact: scout-artifact://workflow-001/verifier/result.md\n</task-outcome>",
  ));
  assert.ok(handoffTurn?.prompt);
  const handoffContext = JSON.parse(attachments.readTagBlock(handoffTurn.prompt, "workflow_context")[0]!.body);
  assert.deepEqual(handoffContext.artifactReferences, [{
    ref: "scout-artifact://workflow-001/verifier/result.md",
    path: join(currentRunScope().workflow.agentPaths("verifier").artifactRoot, "result.md"),
  }]);
  assert.ok(handoffContext.artifacts.every((artifact: object) => !Object.hasOwn(artifact, "referenceRoot")));
  const submittedOutcome = fixture.journal.readAll().find((event) =>
    AgentEvents.task.outcomeSubmitted.is(event)
  );
  assert.ok(submittedOutcome && AgentEvents.task.outcomeSubmitted.is(submittedOutcome));
  assert.equal(
    submittedOutcome.payload.outcome,
    "## Outcome\n\n- Artifact: scout-artifact://workflow-001/verifier/result.md",
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

test("RequestHumanInput yields its Worker turn before a fast human response starts a fresh task step", async () => {
  let worker: WorkerAgent | undefined;
  let coordinator: CoordinatorAgent | undefined;
  let requestSucceeded = false;
  let responseSucceeded = false;
  let submitSucceeded = false;
  let requestTurnFinished = false;
  let responseArrivedBeforeRequestTurnFinished = false;
  let resolveResponseDelivery: (() => void) | undefined;
  const responseDelivered = new Promise<void>((resolve) => {
    resolveResponseDelivery = resolve;
  });
  const steerInputs: Array<{ threadId: string; expectedTurnId: string }> = [];
  const appServer = createFakeAppServer({
    threadIds: ["thread-fast-coordinator", "thread-fast-worker"],
    turnIdForTurn: (turn) => {
      const prompt = turn.prompt ?? "";
      if (prompt.includes("<wait-for-human-request>")) return "turn-fast-coordinator-response";
      if (prompt.includes("<human-response>")) return "turn-fast-worker-submit";
      return "turn-fast-worker-request";
    },
    onRunTurn: async (turn) => {
      const prompt = turn.prompt ?? "";
      if (!worker || !coordinator || !appServer.handler) return;
      if (prompt.includes("<message>\nRequest a fast human response.\n</message>")) {
        const result = await appServer.handler({
          threadId: worker.threadId ?? "",
          turnId: "turn-fast-worker-request",
          callId: "call-fast-human-request",
          namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
          tool: "RequestHumanInput",
          arguments: { request: "Need the target account." },
        });
        requestSucceeded = result.success;
        await responseDelivered;
        requestTurnFinished = true;
        return [{
          namespace: AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
          tool: "RequestHumanInput",
          callId: "call-fast-human-request",
          arguments: { request: "Need the target account." },
          success: result.success,
        }];
      }
      if (prompt.includes("<wait-for-human-request>\nNeed the target account.\n</wait-for-human-request>")) {
        const result = await appServer.handler({
          threadId: coordinator.threadId ?? "",
          turnId: "turn-fast-coordinator-response",
          callId: "call-fast-human-response",
          namespace: AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE,
          tool: "RespondHumanInput",
          arguments: {
            task_id: worker.taskRunner?.snapshot().activeTask?.taskId,
            response: "Use the prepared account.",
          },
        });
        responseSucceeded = result.success;
        responseArrivedBeforeRequestTurnFinished = !requestTurnFinished;
        resolveResponseDelivery?.();
        return;
      }
      if (prompt.includes("response:\nUse the prepared account.\n</human-response>")) {
        const result = await appServer.handler({
          threadId: worker.threadId ?? "",
          turnId: "turn-fast-worker-submit",
          callId: "call-fast-submit",
          namespace: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
          tool: "SubmitTask",
          arguments: { outcome: "## Outcome\n\n- 已使用独立 Step 消费人工响应。" },
        });
        submitSucceeded = result.success;
      }
    },
  });
  appServer.steerTurn = async (input) => {
    steerInputs.push({
      threadId: input.threadId,
      expectedTurnId: input.expectedTurnId,
    });
    return {
      turnId: input.expectedTurnId,
      response: {},
    };
  };
  const fixture = createAgentFixture("worker-fast-human-response", {
    appServer,
    scheduler: new Scheduler(new Graph({ ...createTestScheduler().snapshot(), currentPhase: "verify" })),
  });
  const workerMount = createMount(fixture.root, "verifier");
  const workerCommit = createAssetCommit(workerMount);
  new AgentDynamicToolBackend().start();
  prepareAgent(fixture, "verifier", workerMount, workerCommit);
  const builder = new AgentBuilder();
  coordinator = builder.buildCoordinator();
  await coordinator.startThread();
  worker = builder.buildWorker("verifier") as WorkerAgent;
  await worker.startThread();

  const assignment = await worker.assignTask({
    description: "Exercise a fast human response",
    phase: "verify",
    prompt: agent.turn.message("Request a fast human response."),
    isBackgrounded: true,
  });
  assert.equal(assignment.ok, true);
  if (!assignment.ok) throw new Error("Expected the Worker task assignment to succeed.");

  await worker.runToIdle();
  await coordinator.runToIdle();

  assert.equal(requestSucceeded, true);
  assert.equal(responseSucceeded, true);
  assert.equal(responseArrivedBeforeRequestTurnFinished, true);
  assert.equal(submitSucceeded, true);
  assert.deepEqual(appServer.interruptInputs, [{
    threadId: "thread-fast-worker",
    turnId: "turn-fast-worker-request",
  }]);
  assert.equal(
    steerInputs.some((input) => input.expectedTurnId === "turn-fast-worker-request"),
    false,
  );
  const task = worker.taskRunner?.snapshot().activeTask;
  assert.equal(task?.status, AgentTaskStatuses.Done);
  assert.equal(task?.stepIds.length, 2);
  assert.equal(task?.dispositions[0]?.kind, AgentTaskDispositionKinds.WaitingForHuman);
  assert.equal(task?.dispositions[0]?.stepId, task?.stepIds[0]);
  assert.equal(task?.dispositions[1]?.kind, AgentTaskDispositionKinds.HandoffSubmitted);
  assert.equal(task?.dispositions[1]?.stepId, task?.stepIds[1]);
  assert.notEqual(task?.dispositions[0]?.stepId, task?.dispositions[1]?.stepId);
  const submittedStep = fixture.stepStore.getStep(task?.stepIds[1] ?? "");
  assert.deepEqual(submittedStep?.humanInputReferences, [{
    requestId: task?.dispositions[0]?.kind === AgentTaskDispositionKinds.WaitingForHuman
      ? task.dispositions[0].requestId
      : "",
    kind: "response_consumed",
  }]);

  await Promise.all([
    worker.stopAgent("test_cleanup"),
    coordinator.stopAgent("test_cleanup"),
  ]);
});

test("AssignTask replaces a finished TaskRunner while preserving its thread and Step runner", async () => {
  const appServer = createFakeAppServer();
  const domain = createStaticDomain("domain-archive-task", []);
  const fixture = createAgentFixture("archive-task", { appServer, domain });
  const verifierMount = createMount(fixture.root, "verifier");
  const verifierCommit = createAssetCommit(verifierMount);
  new AgentDynamicToolBackend().start();
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
  assert.match(firstAssignment.value.taskId, /^verifier-task-0001-[0-9a-f-]{36}$/);

  assert.ok(appServer.handler);
  await verifier.stopTask(firstAssignment.value.taskId, "first task ended");
  await verifier.runToIdle();
  assert.ok(verifier.taskRunner);
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
  assert.match(secondAssignment.value.taskId, /^verifier-task-0002-[0-9a-f-]{36}$/);
  assert.notEqual(secondAssignment.value.taskId, firstAssignment.value.taskId);
  assert.equal(secondAssignment.value.taskSequence, 2);
  assert.equal(fixture.taskStore.getTask(firstAssignment.value.taskId), undefined);
  assert.equal(verifier.threadId, workerThreadId);
  assert.equal(verifier.stepRunner, stepRunner);

  await verifier.stopTask(secondAssignment.value.taskId, "test_cleanup");
  await verifier.runToIdle();
  await verifier.releaseTask(secondAssignment.value.taskId);
  await coordinator.stopAgent("test_cleanup");
});

test("removed ArchiveTask cannot be invoked by any agent", async () => {
  const appServer = createFakeAppServer();
  const domain = createStaticDomain("domain-archive-task-role", []);
  const fixture = createAgentFixture("archive-task-role", { appServer, domain });
  const verifierMount = createMount(fixture.root, "verifier");
  const verifierCommit = createAssetCommit(verifierMount);
  new AgentDynamicToolBackend().start();
  prepareAgent(fixture, "verifier", verifierMount, verifierCommit);
  const builder = new AgentBuilder();
  const verifier = builder.buildWorker("verifier") as WorkerAgent;
  await verifier.startThread();

  assert.ok(appServer.handler);
  const result = await appServer.handler({
    threadId: verifier.threadId ?? "",
    turnId: "turn-archive-task-role",
    callId: "call-archive-task-role",
    namespace: "scout_agent_archivetask",
    tool: "ArchiveTask",
    arguments: {
      task_id: "verifier-task-0001",
    },
  });

  assert.equal(result.success, false);
  assert.match(result.contentItems[0]?.text ?? "", /Unsupported dynamic tool namespace|not assigned to the current Workflow Phase/);
});

test("SubmitTask rejects a Coordinator caller", async () => {
  const appServer = createFakeAppServer();
  const domain = createStaticDomain("domain-worker-lifecycle-tool-role", []);
  const fixture = createAgentFixture("worker-lifecycle-tool-role", { appServer, domain });
  new AgentDynamicToolBackend().start();
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

test("Coordinator opens each Workflow only after its requesting Turn and reuses the Thread with fresh execution roots", async () => {
  let backend: AgentDynamicToolBackend;
  let calls = 0;
  const appServer = createFakeAppServer({
    turnIds: ["open-1", "execute-1", "history", "open-2", "execute-2"],
    onRunTurn: async () => {
      const scope = currentRunScope();
      calls += 1;
      if (calls === 1 || calls === 4) {
        assert.equal(scope.workflow.snapshot(), undefined);
        const input = {
          threadId: "thread-test", turnId: calls === 1 ? "open-1" : "open-2", callId: "request-" + calls,
          namespace: AGENT_START_WORKFLOW_TOOL_NAMESPACE, tool: "StartWorkflow", arguments: { prompt: "Run the requested BDD." },
        };
        const accepted = await backend.handleDynamicToolCall(input);
        assert.equal(accepted.success, true, JSON.stringify(accepted));
        assert.deepEqual(await backend.handleDynamicToolCall(input), accepted);
        const duplicate = await backend.handleDynamicToolCall({ ...input, callId: "another-request" });
        assert.equal(duplicate.success, false);
        assert.equal(scope.workflow.snapshot(), undefined, "the requesting Turn has no execution Workflow");
      } else if (calls === 2) {
        assert.equal(scope.workflow.snapshot()?.workflowId, "workflow-001");
        scope.workflow.scheduler.advance("error");
      } else if (calls === 3) {
        assert.equal(scope.workflow.snapshot(), undefined, "history discussion stays empty");
      } else {
        assert.equal(scope.workflow.snapshot()?.workflowId, "workflow-002");
      }
    },
  });
  const fixture = createAgentFixture("explicit-workflow-start", { appServer, withoutActiveWorkflow: true });
  backend = new AgentDynamicToolBackend();
  const scope = currentRunScope();
  const coordinatorAgent = new AgentBuilder().buildCoordinator();
  await coordinatorAgent.startThread();
  try {
    await coordinatorAgent.sendMessage({ message: agent.turn.message("Start a new execution.") });
    await coordinatorAgent.runToIdle();
    assert.equal(calls, 2);
    assert.equal(scope.workflow.snapshot(), undefined);
    await coordinatorAgent.sendMessage({ message: agent.turn.message("Explain the historical result.") });
    await coordinatorAgent.runToIdle();
    assert.equal(calls, 3);
    await coordinatorAgent.sendMessage({ message: agent.turn.message("Start another execution.") });
    await coordinatorAgent.runToIdle();
    assert.equal(calls, 5);
    assert.equal(scope.workflow.snapshot()?.workflowId, "workflow-002");
    assert.equal(appServer.threadInputs.length, 1);
    assert.equal(coordinatorAgent.threadId, "thread-test");
    assert.deepEqual(appServer.turnInputs.map((turn) => turn.runtimeWorkspaceRoots), [
      [], [join(scope.runRoot, "workflows", "workflow-001")], [], [], [join(scope.runRoot, "workflows", "workflow-002")],
    ]);
    assert.ok(appServer.turnInputs.every((turn) => turn.cwd === fixture.mount.mountRoot));
    const contexts = appServer.turnInputs.map((turn) => {
      const prompt = turn.prompt ?? "";
      const context = /<workflow_context>\s*([\s\S]*?)\s*<\/workflow_context>/.exec(prompt);
      assert.ok(context?.[1], "each Turn receives the formal Workflow context");
      assert.doesNotMatch(prompt, /<flow_context>|\bflow_status:|"flowId"/);
      return JSON.parse(context[1]);
    });
    assert.deepEqual(contexts.map((context) => context.status), ["empty", "active", "empty", "empty", "active"]);
    assert.deepEqual(contexts.map((context) => context.workflowId), [undefined, "workflow-001", undefined, undefined, "workflow-002"]);
    assert.equal(contexts[0].artifactRoot, undefined);
    assert.equal(contexts[1].artifactRoot, join(scope.runRoot, "workflows", "workflow-001", "agents", "coordinator", "artifacts"));
    assert.equal(contexts[4].artifactRoot, join(scope.runRoot, "workflows", "workflow-002", "agents", "coordinator", "artifacts"));
    assert.match(appServer.turnInputs[1]!.prompt ?? "", /workflow-001/);
    assert.match(appServer.turnInputs[4]!.prompt ?? "", /workflow-002/);
    assert.doesNotMatch(appServer.turnInputs[4]!.prompt ?? "", /workflow-001/);
    const events = scope.workflow.readEvents();
    assert.equal(events.filter((event) => AgentEvents.turn.started.is(event)).length, 1);
    assert.equal(events.some((event) => AgentEvents.turn.completed.is(event) && event.payload.turn.turnId === "open-2"), false);
  } finally {
    await coordinatorAgent.stopAgent("test_cleanup");
  }
});

test("resumed Workflow resolves handoff refs after a directory rename without rewriting evidence", async () => {
  const appServer = createFakeAppServer({ turnIds: ["before-rename", "after-resume"] });
  createAgentFixture("artifact-path-resume", { appServer });
  const scope = currentRunScope();
  const original = scope.workflow;
  const graphState = original.graph.snapshot();
  const originalRoot = dirname(original.journalRoot);
  const relativePath = "result.json";
  const artifactRoot = original.agentPaths("researcher").artifactRoot;
  mkdirSync(artifactRoot, { recursive: true });
  const ref = "scout-artifact://workflow-001/researcher/result.json";
  const artifactContent = JSON.stringify({ executorHistoryRef: ref, recordLocator: "JR/123", refs: ["SR/456"] });
  writeFileSync(join(artifactRoot, relativePath), artifactContent);
  const prompt = agent.turn.task_outcome(`## Outcome\n\n- Artifact: ${ref}`);
  const coordinator = new AgentBuilder().buildCoordinator();
  await coordinator.startThread();
  let resumed: Workflow | undefined;
  try {
    await coordinator.runTurn({ prompt });
    await original.stop();
    const oldJournal = readFileSync(join(originalRoot, "journal", "scout.journal"), "utf8");
    const renamedRoot = join(scope.runRoot, "workflows", "renamed evidence");
    renameSync(originalRoot, renamedRoot);
    const selected = new ScoutBenchmarks(new Benchmarks(scope.runRoot)).resolve("currentWorkflow");
    assert.ok(selected);
    assert.equal(selected.workflowRoot, renamedRoot);
    const journalPath = join(selected.journalRoot, "scout.journal");
    resumed = new Workflow({
      graphState,
      resume: {
        workflowState: projectWorkflowState(selected.workflowId, readJournalEvents(journalPath)),
        journalRoot: selected.journalRoot,
      },
    });
    scope.clearWorkflow(original);
    scope.setWorkflow(resumed);
    await resumed.start();
    assert.equal(readFileSync(journalPath, "utf8"), oldJournal);
    await coordinator.runTurn({ prompt });
    assert.equal(appServer.threadInputs.length, 1);
    assert.equal(coordinator.threadId, "thread-test");
    const contexts = appServer.turnInputs.map((turn) => {
      assert.ok(turn.prompt);
      assert.ok(turn.prompt.endsWith(prompt), "business prompt is delivered verbatim");
      return JSON.parse(attachments.readTagBlock(turn.prompt, "workflow_context")[0]!.body);
    });
    assert.deepEqual(contexts.map((context) => context.artifactReferences), [
      [{ ref, path: join(artifactRoot, relativePath) }],
      [{ ref, path: join(renamedRoot, "agents", "researcher", "artifacts", relativePath) }],
    ]);
    assert.equal(appServer.turnInputs[1]!.prompt?.includes(originalRoot), false);
    assert.deepEqual(appServer.turnInputs[1]!.runtimeWorkspaceRoots, [renamedRoot]);
    assert.equal(readFileSync(join(renamedRoot, "agents", "researcher", "artifacts", relativePath), "utf8"), artifactContent);
    const turnPrompts = readJournalEvents(journalPath).flatMap((event) =>
      AgentEvents.turn.started.is(event) ? [event.payload.prompt] : []
    );
    assert.deepEqual(turnPrompts, [prompt, prompt]);
  } finally {
    await coordinator.stopAgent("test_cleanup");
    await resumed?.stop();
  }
});

test("empty Workflow does not resolve historical refs or supply artifact access paths", async () => {
  const appServer = createFakeAppServer();
  createAgentFixture("idle-artifact-reference", { appServer, withoutActiveWorkflow: true });
  const coordinator = new AgentBuilder().buildCoordinator();
  await coordinator.startThread();
  try {
    const prompt = "Explain scout-artifact://workflow-001/researcher/result.json";
    await coordinator.runTurn({ prompt });
    const delivered = appServer.turnInputs[0]!.prompt!;
    const context = JSON.parse(attachments.readTagBlock(delivered, "workflow_context")[0]!.body);
    assert.equal(context.status, "empty");
    assert.equal(context.artifactRoot, undefined);
    assert.equal(context.artifacts, undefined);
    assert.equal(context.artifactReferences, undefined);
    assert.deepEqual(appServer.turnInputs[0]!.runtimeWorkspaceRoots, []);
    assert.ok(delivered.endsWith(prompt));
  } finally {
    await coordinator.stopAgent("test_cleanup");
  }
});

for (const status of ["failed", "interrupted"] as const) {
  test(`A ${status} requesting Turn does not open a Workflow`, async () => {
    let backend: AgentDynamicToolBackend;
    const appServer = createFakeAppServer({ turnStatus: status, onRunTurn: async () => {
      const result = await backend.handleDynamicToolCall({
        threadId: "thread-test", turnId: "turn-test", callId: "request", namespace: AGENT_START_WORKFLOW_TOOL_NAMESPACE,
        tool: "StartWorkflow", arguments: { prompt: "Start execution" },
      });
      assert.equal(result.success, true);
    } });
    createAgentFixture("failed-start-workflow-" + status, { appServer, withoutActiveWorkflow: true });
    backend = new AgentDynamicToolBackend();
    const coordinatorAgent = new AgentBuilder().buildCoordinator();
    await coordinatorAgent.startThread();
    try {
      await coordinatorAgent.sendMessage({ message: agent.turn.message("Start execution") });
      await coordinatorAgent.runToIdle();
      assert.equal(currentRunScope().workflow.snapshot(), undefined);
      assert.equal(appServer.turnInputs.length, 1);
    } finally {
      await coordinatorAgent.stopAgent("test_cleanup");
    }
  });
}

function createAgentFixture(
  name: string,
  input: {
    appServer?: ReturnType<typeof createFakeAppServer>;
    domain?: ScoutDomain;
    logger?: Logger;
    interactionPort?: RuntimeInteractionPort;
    scheduler?: Scheduler;
    withoutActiveWorkflow?: boolean;
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
  domainRegistry: RunScope["domainRegistry"];
  logger: Logger;
  journal: { readAll(): JournalEvent[] };
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
  const manifestStore = new RunManifestStore(runRoot);
  const scheduler = input.scheduler ?? createTestScheduler();
  const createdAt = new Date().toISOString();
  let resume: ConstructorParameters<typeof Workflow>[0]["resume"];
  if (!input.withoutActiveWorkflow) {
    const benchmarks = new ScoutBenchmarks(new Benchmarks(runRoot));
    benchmarks.benchmarks.acquire();
    const prepared = benchmarks.prepareNext();
    const seed = Journal.create({ journalId: runId + ":workflow:scout", path: join(prepared.journalRoot, "scout.journal"), lockPath: join(prepared.journalRoot, ".scout.lock") });
    seed.append({ id: runId + "-created", key: RunEvents.run.created, payload: { runId, scoutRoot: root, createdAt }, occurredAt: createdAt });
    seed.append({ id: runId + "-initialized", key: WorkflowEvents.workflow.initialized, payload: { state: scheduler.snapshot(), initializedAt: createdAt }, occurredAt: createdAt });
    seed.close();
    benchmarks.recordStarted(prepared.workflowId);
    benchmarks.benchmarks.release();
    resume = { workflowState: { workflowId: prepared.workflowId, status: "active", checkpointSeq: 2 }, journalRoot: prepared.journalRoot };
  }
  const workflow = new Workflow({ graphState: scheduler.snapshot(), resume });
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
    config: new AssetStore().config(root),
    runRoot,
    logger,
    eventBus,
    interactionPort: input.interactionPort ?? new NoopRuntimeInteractionPort(),
    workflow,
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
  scope.setExecutionSystem({
    identify: async () => ({
      ok: false,
      code: "test_execution_unavailable",
      message: "Execution is not used by this Agent fixture.",
    }),
    launch: async () => ({
      ok: false,
      code: "test_execution_unavailable",
      message: "Execution is not used by this Agent fixture.",
    }),
    shutdown: async () => ({
      ok: false,
      code: "test_execution_unavailable",
      message: "Execution is not used by this Agent fixture.",
    }),
  });
  const releaseScope = installRunScope(scope);
  const baseDomain = new BaseDomain();
  scope.domainRegistry.register(baseDomain);
  scope.domainRegistry.register(domain);
  manifestStore.create({
    runId,
    scoutRoot: root,
    createdAt,
    checkpointSeq: 0,
  });
  void workflow.start();
  releaseTestRunScope = async () => {
    for (const registeredDomain of scope.domainRegistry.list().reverse()) {
      await registeredDomain.stop?.();
      scope.domainRegistry.unregister(registeredDomain);
    }
    await workflow.stop();
    releaseScope();
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
    domainRegistry: scope.domainRegistry,
    logger,
    journal: { readAll: () => workflow.readEvents() },
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
  if (role === "coordinator") {
    writeFileSync(
      join(mountRoot, "agents", "coordinator.AGENTS.md"),
      "coordinator instructions",
      "utf8",
    );
  } else {
    writeFileSync(join(mountRoot, "agents", "worker.AGENTS.md"), "worker instructions", "utf8");
  }
  const guidanceSkills = role === "coordinator"
    ? [
      "tool-scout-assign-task",
      "tool-scout-send-message",
      "tool-scout-respond-human-input",
      "tool-scout-submit-phase-outcome",
    "tool-scout-start-workflow",
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
    agentRoot: dirname(mountRoot),
    issues: [],
    readableRoots: [root],
    writableRoots: [],
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
      requiredFamilyPaths: [],
      optionalFamilyPaths: [],
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
    description: { id: ScoutDomainId.Validation, name: domainId },
    backend: new class extends DomainAgentBackend {
      override dynamicToolsForPhase() { return tools; }

      override async handleDynamicToolCall() { return undefined; }
    }(),
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
  threadIds?: string[];
  turnIdForTurn?: (turn: { prompt?: string }, index: number) => string;
  resolveTimelineEntry?: (entry: AppServerTimelineEntry) => AppServerResolvedTimelineEntry;
  parentThreadIds?: Record<string, string | null>;
  threadSnapshot?: (threadId: string) => AppServerThreadState | undefined;
} = {}): CodexAppServerClient & {
  handler?: DynamicToolCallHandler;
  readonly timelineHandlerCount: number;
  turnInputs: Array<{
    approvalPolicy?: ThreadStartOptions["approvalPolicy"];
    prompt?: string;
      cwd?: string;
      runtimeWorkspaceRoots?: string[];
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
      approvalPolicy?: ThreadStartOptions["approvalPolicy"];
      prompt?: string;
      cwd?: string;
      runtimeWorkspaceRoots?: string[];
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
      const threadIndex = appServer.threadInputs.length;
      appServer.threadInputs.push(threadInput);
      const threadId = options.threadIds?.[threadIndex] ?? "thread-test";
      return {
        threadId,
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
          thread: { id: threadId },
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
      cwd?: string;
      runtimeWorkspaceRoots?: string[];
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
      cwd?: string;
      runtimeWorkspaceRoots?: string[];
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
