import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentBuilder,
  type PreparedAgentInputs,
} from "../../src/agent/builder/agent-builder.js";
import { AgentBackend } from "../../src/agent/backend/agent-backend.js";
import { AgentRegistry } from "../../src/agent/core/agent-registry.js";
import { AgentTaskStore } from "../../src/agent/task/agent-task-store.js";
import { CoordinatorAgent } from "../../src/agent/roles/coordinator-agent.js";
import { ResearcherAgent } from "../../src/agent/roles/researcher-agent.js";
import { ValidatorAgent } from "../../src/agent/roles/validator-agent.js";
import type { ScoutAgentOptions } from "../../src/agent/core/scout-agent.js";
import {
  AGENT_ARCHIVE_TASK_TOOL_NAMESPACE,
  AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
  AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
  AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
} from "../../src/agent/tools/agent-tools.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";
import type { AgentDynamicToolSpec } from "../../src/agent/tools/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import type { DynamicToolCallHandler } from "../../src/agent-server/types.js";
import type {
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
} from "../../src/agent-server/codex/app-server-event-store.js";
import type { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";
import type { AssetCommit, CodexMount } from "../../src/asset-store/index.js";
import type { ScoutDomain } from "../../src/domain/index.js";
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
} from "../../src/interaction/index.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/index.js";
import type { AgentActivity } from "../../src/agent/activity/activity-event.js";
import { InteractionGateway } from "../../src/interaction/index.js";
import { attachments } from "../../src/agent/context/index.js";
import { agent } from "../../src/agent/context/agent-attachments.js";
import { CoordinatorContextTags } from "../../src/agent/runner/coordinator/coordinator-attachments.js";
import type { AgentTaskNotAssignedEventPayload } from "../../src/agent/task/task-events.js";
import type { ScoutEvent } from "../../src/core/events/index.js";
import type { LogEvent, Logger } from "../../src/core/logging/index.js";
import type { WorkerAgent } from "../../src/agent/roles/worker-agent.js";
import type { BootSnapshot } from "../../src/run/boot/boot-stage.js";
import {
  AgentTaskStatuses,
  type AgentTaskStepToolCall,
} from "../../src/agent/task/types.js";

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
  const builder = new AgentBuilder({
    preparedAgents: fixture.preparedAgents,
  });

  const agent = builder.buildCoordinator();
  const tools = agent.spec.dynamicTools ?? [];

  assert.ok(agent instanceof CoordinatorAgent);
  assert.equal(agent.runner.runnerKind, "coordinator");
  assert.deepEqual(agent.spec.model, {
    id: "gpt-5.5",
    provider: "GuruOpenAI",
    reasoningEffort: "high",
    reasoningSummary: "concise",
  });
  assert.deepEqual(agent.spec.config?.features, {
    shell_tool: true,
    multi_agent: false,
    apps: false,
  });
  assert.equal(fixture.registry.listAgents()[0], agent);
  assert.ok(tools.some((tool) => tool.namespace === AGENT_ASSIGN_TASK_TOOL_NAMESPACE && tool.name === "AssignTask"));
  assert.ok(tools.some((tool) => tool.namespace === AGENT_SEND_MESSAGE_TOOL_NAMESPACE && tool.name === "SendMessage"));
  assert.ok(tools.some((tool) => tool.namespace === AGENT_ARCHIVE_TASK_TOOL_NAMESPACE && tool.name === "ArchiveTask"));
  assert.equal(tools.some((tool) => tool.name === "SubmitTask"), false);
  assert.ok(tools.some((tool) => tool.namespace === "domain-a" && tool.name === "DomainProbe"));
  assert.equal(tools.some((tool) => tool.namespace === "domain-b"), false);
});

test("AgentBuilder creates one worker role while preserving domain tool scope", () => {
  const fixture = createAgentFixture("builder-worker", {
    domain: createStaticDomain("domain-worker", [buildDomainTool("domain-worker")]),
  });
  const researcherMount = createMount(fixture.root, ScoutAgentRoles.Researcher);
  const researcherCommit = createAssetCommit(researcherMount);
  const builder = new AgentBuilder({
    preparedAgents: {
      ...fixture.preparedAgents,
      [ScoutAgentRoles.Researcher]: {
        agentMount: researcherMount,
        assetCommit: researcherCommit,
      },
    },
  });

  const agent = builder.buildWorker(ScoutAgentRoles.Researcher);
  const tools = agent.spec.dynamicTools ?? [];

  assert.ok(agent instanceof ResearcherAgent);
  assert.equal(agent.runner, undefined);
  assert.equal(fixture.registry.resolveAgent(ScoutAgentRoles.Researcher), agent);
  assert.ok(tools.some((tool) => tool.namespace === AGENT_SEND_MESSAGE_TOOL_NAMESPACE && tool.name === "SendMessage"));
  assert.ok(tools.some((tool) => tool.namespace === AGENT_SUBMIT_TASK_TOOL_NAMESPACE && tool.name === "SubmitTask"));
  assert.deepEqual(tools.filter((tool) => tool.namespace !== "domain-worker").map((tool) => tool.name), [
    "SendMessage",
    "SubmitTask",
  ]);
  assert.equal(tools.some((tool) => tool.name === "AssignTask"), false);
  assert.equal(tools.some((tool) => tool.name === "ArchiveTask"), false);
  assert.ok(tools.some((tool) => tool.namespace === "domain-worker" && tool.name === "DomainProbe"));
});

test("Validator turns use workspace-write with only the profile write roots", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("builder-validator-write-roots", { appServer });
  const validatorMount = createMount(fixture.root, ScoutAgentRoles.Validator);
  const validatorCommit = createAssetCommit(validatorMount);
  const validator = new AgentBuilder({
    preparedAgents: {
      ...fixture.preparedAgents,
      [ScoutAgentRoles.Validator]: {
        agentMount: validatorMount,
        assetCommit: validatorCommit,
      },
    },
  }).buildWorker(ScoutAgentRoles.Validator);

  assert.ok(validator instanceof ValidatorAgent);
  assert.equal(validator.spec.sandbox, "workspace-write");
  await validator.start();
  await validator.runTurn({ prompt: "Write the Research Pack Gate." });

  assert.deepEqual(appServer.turnInputs[0]?.writableRoots, [validatorMount.artifactRoot]);
  assert.equal(appServer.turnInputs[0]?.writableRoots?.includes(validatorMount.mountRoot), false);
});

test("Worker turns preserve profile write-root order for sandbox application", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("builder-worker-write-root-order", { appServer });
  const researcherMount = createMount(fixture.root, ScoutAgentRoles.Researcher);
  const codebaseRoot = join(fixture.root, "managed-codebase");
  researcherMount.writableRoots = [
    researcherMount.mountRoot,
    researcherMount.artifactRoot,
    codebaseRoot,
  ];
  const researcher = new AgentBuilder({
    preparedAgents: {
      ...fixture.preparedAgents,
      [ScoutAgentRoles.Researcher]: {
        agentMount: researcherMount,
        assetCommit: createAssetCommit(researcherMount),
      },
    },
  }).buildWorker(ScoutAgentRoles.Researcher);

  await researcher.start();
  await researcher.runTurn({ prompt: "Inspect the Research inputs." });

  assert.deepEqual(appServer.turnInputs[0]?.writableRoots, [
    researcherMount.mountRoot,
    researcherMount.artifactRoot,
    codebaseRoot,
  ]);
});

test("WorkerAgent keeps its bound runner and reports a rejected task assignment", async () => {
  const appServer = createFakeAppServer();
  const domain = createStaticDomain("domain-task-not-assigned", []);
  const fixture = createAgentFixture("worker-task-not-assigned", { appServer, domain });
  const researcherMount = createMount(fixture.root, ScoutAgentRoles.Researcher);
  const researcherCommit = createAssetCommit(researcherMount);
  const builder = new AgentBuilder({
    preparedAgents: {
      ...fixture.preparedAgents,
      [ScoutAgentRoles.Researcher]: {
        agentMount: researcherMount,
        assetCommit: researcherCommit,
      },
    },
  });
  const coordinatorAgent = builder.buildCoordinator();
  await coordinatorAgent.start();
  const worker = builder.buildWorker(ScoutAgentRoles.Researcher) as WorkerAgent;
  new AgentBackend({
    agentProvider: {
      resolveWorker(input): WorkerAgent {
        return fixture.registry.resolveAgent(input.role) as WorkerAgent;
      },
    },
  }).start();
  const notAssignedEvents: AgentTaskNotAssignedEventPayload[] = [];
  fixture.eventBus.subscribe<AgentTaskNotAssignedEventPayload>(
    AgentEvents.task.notAssigned,
    (event) => {
      notAssignedEvents.push(event.payload);
    },
  );

  const firstAssignment = worker.assignTask({
    taskId: "researcher-task-0001",
    description: "Research the first BDD",
    subagentType: ScoutAgentRoles.Researcher,
    prompt: agent.turn.message("Research the first BDD."),
    isBackgrounded: true,
  });
  assert.equal(firstAssignment.ok, true);
  if (!firstAssignment.ok) throw new Error("Expected the first task to be assigned.");
  const boundRunner = worker.runner;
  assert.ok(boundRunner);

  assert.ok(appServer.handler);
  const secondAssignmentPromise = appServer.handler({
    threadId: coordinatorAgent.threadId ?? "",
    turnId: "turn-task-not-assigned",
    callId: "call-task-not-assigned",
    namespace: AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
    tool: "AssignTask",
    arguments: {
      description: "Research another BDD",
      subagent_type: ScoutAgentRoles.Researcher,
      prompt: "Research another BDD.",
    },
  });
  boundRunner.stop("test_cleanup");
  const secondAssignment = await secondAssignmentPromise;
  const rejectionReason = "The worker agent already has a task that has not been archived.";

  assert.equal(secondAssignment.success, true);
  assert.deepEqual(JSON.parse(secondAssignment.contentItems[0]?.text ?? "{}"), {
    status: "not_assigned",
    agentId: ScoutAgentRoles.Researcher,
    role: ScoutAgentRoles.Researcher,
    activeTaskId: "researcher-task-0001",
    reason: rejectionReason,
  });
  assert.equal(worker.runner, boundRunner);
  assert.equal(fixture.taskStore.listTasks().length, 1);
  assert.deepEqual(notAssignedEvents, [{
    agentId: ScoutAgentRoles.Researcher,
    role: ScoutAgentRoles.Researcher,
    activeTaskId: "researcher-task-0001",
    requestedDescription: "Research another BDD",
    reason: rejectionReason,
  }]);

  await waitFor(() =>
    readCoordinatorTaskNotAssignedObservations(appServer.turnInputs)
      .some((observation) => observation.activeTaskId === "researcher-task-0001"
        && observation.reason === rejectionReason)
  );
  coordinatorAgent.runner.stop();
});

test("AgentRegistry indexes registered agents and thread bindings without owning thread startup", () => {
  const fixture = createAgentFixture("registry-bind");
  const builder = new AgentBuilder({
    preparedAgents: fixture.preparedAgents,
  });
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
  const builder = new AgentBuilder({
    preparedAgents: fixture.preparedAgents,
  });
  const agent = builder.buildCoordinator();

  const thread = await agent.start();

  assert.equal(thread.threadId, "thread-test");
  assert.deepEqual(thread.response, { thread: { id: "thread-test" } });
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
  await waitFor(() => agent.threadSnapshot?.threadPreflight?.result.status === "passed");
  assert.equal(agent.threadSnapshot?.threadPreflight?.threadId, "thread-test");

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
});

test("ScoutAgent returns no goal when setting a goal fails", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("goal-failure", { appServer });
  const coordinator = new CoordinatorAgent(fixture.options);
  fixture.registry.registerAgent(coordinator);
  await coordinator.start();

  const goal = await coordinator.setGoal({
    objective: "g".repeat(1000),
  });

  assert.equal(goal, undefined);
  coordinator.runner.stop();
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
  new AgentBackend({
    agentProvider: {
      resolveWorker(input): WorkerAgent {
        return registry.resolveAgent(input.role) as WorkerAgent;
      },
    },
  }).start();
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
  const appServer = createFakeAppServer({
    resolveTimelineEntry: () => ({
      entry,
      item: {
        id: "reasoning-1",
        type: "reasoning",
        status: "completed",
        summary: ["Inspect current evidence."],
        content: ["private chain of thought"],
      },
    }),
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
  new AgentBackend({
    agentProvider: {
      resolveWorker(input): WorkerAgent {
        return fixture.registry.resolveAgent(input.role) as WorkerAgent;
      },
    },
  }).start();

  appServer.emitTimeline(entry);

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

test("AgentBackend logs only health failures from an unbound app-server event burst", () => {
  const appServer = createFakeAppServer();
  const logs: Array<Omit<LogEvent, "timestamp" | "level" | "runId"> & { level: string }> = [];
  const logger = createCaptureLogger(logs);
  const fixture = createAgentFixture("app-server-log-volume", {
    appServer,
    domain: createStaticDomain("domain-app-server-log-volume", []),
    logger,
  });
  new AgentBackend({
    agentProvider: {
      resolveWorker(input): WorkerAgent {
        return fixture.registry.resolveAgent(input.role) as WorkerAgent;
      },
    },
  }).start();

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
  const backend = new AgentBackend({
    agentProvider: {
      resolveWorker(input): WorkerAgent {
        return fixture.registry.resolveAgent(input.role) as WorkerAgent;
      },
    },
  });

  backend.start();
  assert.ok(appServer.handler);
  assert.equal(appServer.timelineHandlerCount, 1);

  backend.stop();
  backend.stop();
  assert.equal(appServer.handler, undefined);
  assert.equal(appServer.timelineHandlerCount, 0);
});

test("SendMessage reports an undelivered message when the target Worker has no runner", async () => {
  const appServer = createFakeAppServer();
  const domain = createStaticDomain("domain-send-message-no-worker-runner", []);
  const fixture = createAgentFixture("send-message-no-worker-runner", { appServer, domain });
  const verifierMount = createMount(fixture.root, ScoutAgentRoles.Verifier);
  const verifierCommit = createAssetCommit(verifierMount);
  new AgentBackend({
    agentProvider: {
      resolveWorker(input): WorkerAgent {
        return fixture.registry.resolveAgent(input.role) as WorkerAgent;
      },
    },
  }).start();
  const builder = new AgentBuilder({
    preparedAgents: {
      ...fixture.preparedAgents,
      [ScoutAgentRoles.Verifier]: {
        agentMount: verifierMount,
        assetCommit: verifierCommit,
      },
    },
  });
  const coordinator = builder.buildCoordinator();
  await coordinator.start();
  const verifier = builder.buildWorker(ScoutAgentRoles.Verifier) as WorkerAgent;
  await verifier.start();

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
  assert.match(result.contentItems[0]?.text ?? "", /has no task runner/);
});

test("Worker SendMessage reaches Coordinator and Coordinator output reaches the interaction port", async () => {
  const appServer = createFakeAppServer({
    finalResponse: "Need expected result.",
  });
  const domain = createStaticDomain("domain-worker-message-to-coordinator", []);
  const fixture = createAgentFixture("worker-message-to-coordinator", { appServer, domain });
  const verifierMount = createMount(fixture.root, ScoutAgentRoles.Verifier);
  const verifierCommit = createAssetCommit(verifierMount);
  new AgentBackend({
    agentProvider: {
      resolveWorker(input): WorkerAgent {
        return fixture.registry.resolveAgent(input.role) as WorkerAgent;
      },
    },
  }).start();
  const builder = new AgentBuilder({
    preparedAgents: {
      ...fixture.preparedAgents,
      [ScoutAgentRoles.Verifier]: {
        agentMount: verifierMount,
        assetCommit: verifierCommit,
      },
    },
  });
  const coordinator = builder.buildCoordinator();
  await coordinator.start();
  const verifier = builder.buildWorker(ScoutAgentRoles.Verifier) as WorkerAgent;
  await verifier.start();
  const interactionPort = new CapturingInteractionPort();
  const interactionGateway = new InteractionGateway({
    eventBus: fixture.eventBus,
    interactionPort,
    logger: fixture.logger,
  });
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
      message: agent.turn.message("Need expected result."),
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

test("Worker lifecycle attachments deliver to Coordinator and update the bound task", async () => {
  let verifier: WorkerAgent | undefined;
  let requestSucceeded = false;
  let submitSucceeded = false;
  const appServer = createFakeAppServer({
    onRunTurn: async (turn) => {
      const prompt = turn.prompt ?? "";
      if (!verifier || !appServer.handler) return;
      if (prompt.includes("<message>\nPerform lifecycle handoff.\n</message>")) {
        const message = agent.turn.wait_for_human_request("Need target account.");
        const result = await appServer.handler({
          threadId: verifier.threadId ?? "",
          turnId: "turn-wait-for-human-input",
          callId: "call-wait-for-human-input",
          namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
          tool: "SendMessage",
          arguments: {
            to: ScoutAgentRoles.Coordinator,
            message,
          },
        });
        requestSucceeded = result.success;
        return [{
          namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
          tool: "SendMessage",
          callId: "call-wait-for-human-input",
          arguments: {
            to: ScoutAgentRoles.Coordinator,
            message,
          },
          success: result.success,
        }];
      }
      if (prompt.includes("<human-response>\nUse staging account.\n</human-response>")) {
        const result = await appServer.handler({
          threadId: verifier.threadId ?? "",
          turnId: "turn-submit-task",
          callId: "call-submit-task",
          namespace: AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
          tool: "SubmitTask",
          arguments: {
            outcome: "## Outcome\n\n- Artifact: artifacts/result.md",
          },
        });
        submitSucceeded = result.success;
      }
    },
  });
  const domain = createStaticDomain("domain-worker-lifecycle-tools", []);
  const fixture = createAgentFixture("worker-lifecycle-tools", { appServer, domain });
  const verifierMount = createMount(fixture.root, ScoutAgentRoles.Verifier);
  const verifierCommit = createAssetCommit(verifierMount);
  new AgentBackend({
    agentProvider: {
      resolveWorker(input): WorkerAgent {
        return fixture.registry.resolveAgent(input.role) as WorkerAgent;
      },
    },
  }).start();
  const builder = new AgentBuilder({
    preparedAgents: {
      ...fixture.preparedAgents,
      [ScoutAgentRoles.Verifier]: {
        agentMount: verifierMount,
        assetCommit: verifierCommit,
      },
    },
  });
  const coordinator = builder.buildCoordinator();
  await coordinator.start();
  fixture.registry.bindThread(coordinator.agentId, "thread-coordinator");
  verifier = builder.buildWorker(ScoutAgentRoles.Verifier) as WorkerAgent;
  await verifier.start();
  const assignment = verifier.assignTask({
    description: "Exercise explicit lifecycle tools",
    subagentType: ScoutAgentRoles.Verifier,
    prompt: agent.turn.message("Perform lifecycle handoff."),
    isBackgrounded: true,
  });
  assert.equal(assignment.ok, true);
  if (!assignment.ok || !verifier.runner) throw new Error("Expected the Worker task assignment to succeed.");
  const runner = verifier.runner;

  await runner.runTasksToIdle();

  assert.equal(requestSucceeded, true);
  assert.equal(runner.snapshot().activeTask?.status, AgentTaskStatuses.Running);
  assert.deepEqual(runner.snapshot().activeTask?.steps?.[0]?.humanInputRequest, {
    body: "Need target account.",
  });
  assert.ok(appServer.turnInputs.some((turn) =>
    turn.prompt?.includes("<wait-for-human-request>\nNeed target account.\n</wait-for-human-request>")
  ));

  assert.ok(appServer.handler);
  const response = await appServer.handler({
    threadId: "thread-coordinator",
    turnId: "turn-human-response",
    callId: "call-human-response",
    namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
    tool: "SendMessage",
    arguments: {
      to: assignment.value.taskId,
      message: agent.turn.human_response("Use staging account."),
    },
  });
  assert.equal(response.success, true);
  await runner.runTasksToIdle();

  assert.equal(submitSucceeded, true);
  assert.equal(runner.snapshot().activeTask?.status, AgentTaskStatuses.Done);
  assert.deepEqual(runner.snapshot().activeTask?.steps?.[1]?.humanInputResponse, {
    body: "Use staging account.",
  });
  assert.ok(appServer.turnInputs.some((turn) =>
    turn.prompt?.includes("<task-outcome>\n## Outcome\n\n- Artifact: artifacts/result.md\n</task-outcome>")
  ));
  coordinator.runner.stop();
});

test("ArchiveTask releases a Worker runner while preserving its thread and task sequence", async () => {
  const appServer = createFakeAppServer();
  const domain = createStaticDomain("domain-archive-task", []);
  const fixture = createAgentFixture("archive-task", { appServer, domain });
  const verifierMount = createMount(fixture.root, ScoutAgentRoles.Verifier);
  const verifierCommit = createAssetCommit(verifierMount);
  new AgentBackend({
    agentProvider: {
      resolveWorker(input): WorkerAgent {
        return fixture.registry.resolveAgent(input.role) as WorkerAgent;
      },
    },
  }).start();
  const builder = new AgentBuilder({
    preparedAgents: {
      ...fixture.preparedAgents,
      [ScoutAgentRoles.Verifier]: {
        agentMount: verifierMount,
        assetCommit: verifierCommit,
      },
    },
  });
  const coordinator = builder.buildCoordinator();
  await coordinator.start();
  const verifier = builder.buildWorker(ScoutAgentRoles.Verifier) as WorkerAgent;
  await verifier.start();
  fixture.registry.bindThread(coordinator.agentId, "thread-coordinator");
  const workerThreadId = verifier.threadId;
  const firstAssignment = verifier.assignTask({
    description: "Verify the first BDD",
    subagentType: ScoutAgentRoles.Verifier,
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
    agentId: ScoutAgentRoles.Verifier,
    role: ScoutAgentRoles.Verifier,
  });
  assert.equal(fixture.taskStore.getTask("verifier-task-0001"), undefined);
  assert.equal(verifier.runner, undefined);
  assert.equal(verifier.threadId, workerThreadId);

  const secondAssignment = verifier.assignTask({
    description: "Verify the second BDD",
    subagentType: ScoutAgentRoles.Verifier,
    prompt: agent.turn.message("Verify the second behavior."),
    isBackgrounded: true,
  });
  assert.equal(secondAssignment.ok, true);
  if (!secondAssignment.ok) throw new Error("Expected the second task assignment to succeed.");
  assert.equal(secondAssignment.value.taskId, "verifier-task-0002");
  assert.equal(secondAssignment.value.taskSequence, 2);
  assert.equal(verifier.threadId, workerThreadId);

  await verifier.archiveTask(secondAssignment.value.taskId);
  coordinator.runner.stop();
});

test("ArchiveTask rejects non-Coordinator callers", async () => {
  const appServer = createFakeAppServer();
  const domain = createStaticDomain("domain-archive-task-role", []);
  const fixture = createAgentFixture("archive-task-role", { appServer, domain });
  const verifierMount = createMount(fixture.root, ScoutAgentRoles.Verifier);
  const verifierCommit = createAssetCommit(verifierMount);
  new AgentBackend({
    agentProvider: {
      resolveWorker(input): WorkerAgent {
        return fixture.registry.resolveAgent(input.role) as WorkerAgent;
      },
    },
  }).start();
  const builder = new AgentBuilder({
    preparedAgents: {
      ...fixture.preparedAgents,
      [ScoutAgentRoles.Verifier]: {
        agentMount: verifierMount,
        assetCommit: verifierCommit,
      },
    },
  });
  const verifier = builder.buildWorker(ScoutAgentRoles.Verifier) as WorkerAgent;
  await verifier.start();

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
  new AgentBackend({
    agentProvider: {
      resolveWorker(input): WorkerAgent {
        return fixture.registry.resolveAgent(input.role) as WorkerAgent;
      },
    },
  }).start();
  const coordinator = new AgentBuilder({
    preparedAgents: fixture.preparedAgents,
  }).buildCoordinator();
  await coordinator.start();

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
  coordinator.runner.stop();
});

test("AgentTaskStore snapshots are immutable from callers", () => {
  const fixture = createAgentFixture("task-store-immutable");
  const task = fixture.taskStore.addTask({
    type: "local_agent",
    taskId: "task-immutable",
    taskSequence: 1,
    agentId: "agent-1",
    role: ScoutAgentRoles.Verifier,
    description: "Immutable task",
    initialPrompt: "Do work",
    status: AgentTaskStatuses.Queued,
    isBackgrounded: true,
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
  } = {},
): {
  root: string;
  mount: CodexMount;
  assetCommit: AssetCommit;
  options: ScoutAgentOptions;
  preparedAgents: PreparedAgentInputs;
  registry: AgentRegistry;
  taskStore: AgentTaskStore;
  eventBus: InMemoryEventBus;
  logger: Logger;
} {
  const root = mkdtempSync(join(tmpdir(), `scout-${name}-`));
  const mount = createMount(root, ScoutAgentRoles.Coordinator);
  const assetCommit = createAssetCommit(mount);
  const appServer = input.appServer ?? createFakeAppServer();
  const domain = input.domain ?? createStaticDomain(`domain-${name}`, []);
  const eventBus = new InMemoryEventBus();
  const logger = input.logger ?? createNoopLogger();
  const contextBundle = buildRunContextBundle({
    runId: `run-${name}`,
    assetCommit,
  });
  if (releaseTestRunScope) {
    throw new Error("Test run scope was not released before creating another fixture.");
  }
  const scope = new RunScope({
    runId: `run-${name}`,
    repoRoot: root,
    logger,
    eventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    domain,
    terminate: async () => undefined,
  });
  scope.setAppServer(appServer);
  scope.setEnvironment({
    agents: {} as RunEnvironment["agents"],
    rootAccess: {
      mountRoots: [mount.mountRoot],
      trustedRoots: [],
      writableRoots: [],
    },
    contextBundle,
  });
  releaseTestRunScope = installRunScope(scope);
  const registry = scope.agentRegistry;
  const taskStore = scope.taskStore;
  const options: ScoutAgentOptions = {
    agentMount: mount,
    assetCommit,
  };
  const preparedAgents = {
    [ScoutAgentRoles.Coordinator]: {
      agentMount: mount,
      assetCommit,
    },
  };
  return {
    root,
    mount,
    assetCommit,
    options,
    preparedAgents,
    registry,
    taskStore,
    eventBus,
    logger,
  };
}

function createMount(root: string, role: string): CodexMount {
  const mountRoot = join(root, role, "mount");
  const artifactRoot = join(root, role, "artifacts");
  const logsRoot = join(root, role, "logs");
  mkdirSync(join(mountRoot, "agents"), { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(logsRoot, { recursive: true });
  for (const agentRole of Object.values(ScoutAgentRoles)) {
    writeFileSync(
      join(mountRoot, "agents", `${agentRole}.AGENTS.md`),
      `${agentRole} instructions`,
      "utf8",
    );
  }
  writeFileSync(join(mountRoot, "agents", "worker.AGENTS.md"), "worker instructions", "utf8");

  return {
    agentId: role,
    agentProfile: {
      config: "config/config.toml",
      model: {
        id: "gpt-5.5",
        provider: "GuruOpenAI",
        reasoningEffort: "high",
        reasoningSummary: "concise",
      },
      skills: [],
      mcpServers: [],
      plugins: [],
    },
    assetCommitId: `ac_${role}`,
    mountId: `mount-${role}`,
    mountRoot,
    runRoot: root,
    artifactRoot,
    logsRoot,
    issues: [],
    trustedRoots: [root],
    writableRoots: [artifactRoot],
    shellTools: [],
    mcpServers: [],
    skills: [],
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
  readonly taskEvents: ScoutEvent[] = [];
  readonly agentMessages: AgentMessageReply[] = [];

  async publishBootSnapshot(_snapshot: BootSnapshot): Promise<void> {
    return undefined;
  }

  async disclose(event: RuntimeDisclosureEvent): Promise<void> {
    this.disclosures.push(event);
  }

  async publishAgentActivity(activity: AgentActivity): Promise<void> {
    this.activities.push(activity);
  }

  async publishTaskEvent(event: ScoutEvent): Promise<void> {
    this.taskEvents.push(event);
  }

  async receiveAgentMessage(message: AgentMessageReply): Promise<void> {
    this.agentMessages.push(message);
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

function createFakeAppServer(options: {
  onRunTurn?: (
    turn: { prompt?: string },
  ) => AgentTaskStepToolCall[] | void | Promise<AgentTaskStepToolCall[] | void>;
  finalResponse?: string;
  resolveTimelineEntry?: (entry: AppServerTimelineEntry) => AppServerResolvedTimelineEntry;
} = {}): CodexAppServerClient & {
  handler?: DynamicToolCallHandler;
  readonly timelineHandlerCount: number;
  turnInputs: Array<{
    prompt?: string;
    model?: string;
    reasoningEffort?: string;
    reasoningSummary?: string;
    writableRoots?: string[];
  }>;
  threadInputs: Array<{
    model?: string;
    modelProvider?: string;
    reasoningEffort?: string;
  }>;
  emitTimeline(entry: AppServerTimelineEntry): void;
} {
  const timelineHandlers: Array<(entry: AppServerTimelineEntry) => void> = [];
  const appServer = {
    turnInputs: [] as Array<{
      prompt?: string;
      model?: string;
      reasoningEffort?: string;
      reasoningSummary?: string;
      writableRoots?: string[];
    }>,
    threadInputs: [] as Array<{
      model?: string;
      modelProvider?: string;
      reasoningEffort?: string;
    }>,
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
    startThread: async (threadInput: {
      model?: string;
      modelProvider?: string;
      reasoningEffort?: string;
    }) => {
      appServer.threadInputs.push(threadInput);
      return {
        threadId: "thread-test",
        response: {
          thread: { id: "thread-test" },
        },
      };
    },
    startSession: async () => undefined,
    close: () => undefined,
    request: async (method: string, params: unknown) => {
      if (method === "mcpServerStatus/list") {
        return {
          method,
          params,
          servers: [],
        };
      }
      return {
        method,
        params,
      };
    },
    setThreadGoal: async () => {
      throw new Error("ephemeral thread does not support goals");
    },
    runTurn: async (turnInput: {
      prompt?: string;
      model?: string;
      reasoningEffort?: string;
      reasoningSummary?: string;
      writableRoots?: string[];
    }) => {
      appServer.turnInputs.push(turnInput);
      const toolCalls = await options.onRunTurn?.(turnInput);
      return {
        finalResponse: options.finalResponse ?? "",
        response: {},
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
      writableRoots?: string[];
    }>;
    threadInputs: Array<{
      model?: string;
      modelProvider?: string;
      reasoningEffort?: string;
    }>;
    emitTimeline(entry: AppServerTimelineEntry): void;
  };
  return appServer;
}
