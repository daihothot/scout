import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentBuilder,
  type AgentBuilderRuntime,
  type PreparedAgentInputs,
} from "../../src/agent/builder/agent-builder.js";
import { AgentBackend } from "../../src/agent/backend/agent-backend.js";
import { AgentRegistry } from "../../src/agent/core/agent-registry.js";
import { AgentTaskStore } from "../../src/agent/task/agent-task-store.js";
import { CoordinatorAgent } from "../../src/agent/roles/coordinator-agent.js";
import { ResearcherAgent } from "../../src/agent/roles/researcher-agent.js";
import type { ScoutAgent, ScoutAgentOptions } from "../../src/agent/core/scout-agent.js";
import { AgentOrchestrator } from "../../src/agent/orchestration/agent-orchestrator.js";
import {
  SYSTEM_AGENT_TOOL_NAMESPACE,
  SYSTEM_HUMAN_INPUT_TOOL_NAMESPACE,
  SYSTEM_SEND_MESSAGE_TOOL_NAMESPACE,
} from "../../src/agent/tools/system-tools.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";
import type { AgentDynamicToolSpec } from "../../src/agent/tools/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { SystemEvents } from "../../src/system/events/index.js";
import type { DynamicToolCallHandler } from "../../src/agent-server/types.js";
import type { AssetCommit, CodexMount } from "../../src/asset-store/index.js";
import type { ScoutDomain } from "../../src/domain/index.js";
import { ValidationDomain } from "../../src/domain/index.js";
import {
  GET_VALIDATION_STATE_SNAPSHOT_TOOL,
  VALIDATION_DOMAIN_TOOL_NAMESPACE,
} from "../../src/domain/validation/tools/index.js";
import { buildRunContextBundle } from "../../src/run/types.js";
import type {
  HumanInputRequest,
  RuntimeDisclosureEvent,
  RuntimeInteractionPort,
  RuntimeProgressEvent,
} from "../../src/interaction/index.js";
import { InteractionGateway } from "../../src/interaction/index.js";
import type { AgentTaskSystemEvent } from "../../src/agent/task/task-events.js";
import type { SystemInterruptEventPayload } from "../../src/agent/orchestration/orchestrator-events.js";
import type { ScoutEvent } from "../../src/core/events/index.js";
import type { WorkerRunner } from "../../src/agent/runner/worker/worker-runner.js";
import {
  AgentTaskStatuses,
  AgentTaskStepStatuses,
} from "../../src/agent/task/types.js";

test("AgentBuilder creates a coordinator with system and single-domain tools", () => {
  const fixture = createAgentFixture("builder-coordinator");
  const domainTool = buildDomainTool("domain-a");
  const builder = new AgentBuilder({
    domain: createStaticDomain("domain-a", [domainTool]),
    registry: fixture.registry,
    taskStore: fixture.taskStore,
    runtime: fixture.runtime,
    preparedAgents: fixture.preparedAgents,
  });

  const agent = builder.buildCoordinator();
  const tools = agent.spec.dynamicTools ?? [];

  assert.ok(agent instanceof CoordinatorAgent);
  assert.equal(agent.runner.runnerKind, "coordinator");
  assert.equal(fixture.registry.listAgents()[0], agent);
  assert.ok(tools.some((tool) => tool.namespace === SYSTEM_AGENT_TOOL_NAMESPACE && tool.name === "AgentTool"));
  assert.ok(tools.some((tool) => tool.namespace === SYSTEM_SEND_MESSAGE_TOOL_NAMESPACE && tool.name === "SendMessage"));
  assert.ok(tools.some((tool) => tool.namespace === SYSTEM_HUMAN_INPUT_TOOL_NAMESPACE && tool.name === "RequestHumanInput"));
  assert.ok(tools.some((tool) => tool.namespace === "domain-a" && tool.name === "DomainProbe"));
  assert.equal(tools.some((tool) => tool.namespace === "domain-b"), false);
});

test("AgentBuilder creates one worker role while preserving domain tool scope", () => {
  const fixture = createAgentFixture("builder-worker");
  const researcherMount = createMount(fixture.root, ScoutAgentRoles.Researcher);
  const researcherCommit = createAssetCommit(researcherMount);
  const builder = new AgentBuilder({
    domain: createStaticDomain("domain-worker", [buildDomainTool("domain-worker")]),
    registry: fixture.registry,
    taskStore: fixture.taskStore,
    runtime: fixture.runtime,
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
  assert.equal(agent.runner.runnerKind, "worker");
  assert.equal(fixture.registry.resolveAgent(ScoutAgentRoles.Researcher), agent);
  assert.ok(tools.some((tool) => tool.namespace === SYSTEM_HUMAN_INPUT_TOOL_NAMESPACE && tool.name === "RequestHumanInput"));
  assert.deepEqual(tools.filter((tool) => tool.namespace !== "domain-worker").map((tool) => tool.name), ["RequestHumanInput"]);
  assert.equal(tools.some((tool) => tool.name === "AgentTool"), false);
  assert.equal(tools.some((tool) => tool.name === "SendMessage"), false);
  assert.ok(tools.some((tool) => tool.namespace === "domain-worker" && tool.name === "DomainProbe"));
});

test("AgentRegistry indexes registered agents and thread bindings without owning thread startup", () => {
  const fixture = createAgentFixture("registry-bind");
  const builder = new AgentBuilder({
    domain: createStaticDomain("domain-registry", []),
    registry: fixture.registry,
    taskStore: fixture.taskStore,
    runtime: fixture.runtime,
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
  const fixture = createAgentFixture("thread-start", appServer);
  const builder = new AgentBuilder({
    domain: createStaticDomain("domain-thread", []),
    registry: fixture.registry,
    taskStore: fixture.taskStore,
    runtime: fixture.runtime,
    preparedAgents: fixture.preparedAgents,
  });
  const agent = builder.buildCoordinator();

  const thread = await agent.start();

  assert.equal(thread.threadId, "thread-test");
  assert.deepEqual(thread.response, { thread: { id: "thread-test" } });
  assert.equal(fixture.registry.resolveAgentByThreadId("thread-test"), agent);
  await waitFor(() => agent.threadSnapshot?.threadPreflight?.result.status === "passed");
  assert.equal(agent.threadSnapshot?.threadPreflight?.threadId, "thread-test");
});

test("AgentToolBackend routes non-system dynamic tools to the registered domain", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("domain-route", appServer);
  const domain = new ValidationDomain({
    runId: "run-domain-route",
  });
  const registry = fixture.registry;
  const agentBackend = new AgentBackend({
    appServer,
    runId: "run-domain-route",
    registry,
    taskStore: fixture.taskStore,
    eventBus: fixture.options.eventBus,
    agentProvider: {
      resolveWorker(input): ScoutAgent {
        return registry.resolveAgent(input.role);
      },
    },
    logger: fixture.options.logger,
    domain,
  });
  const builder = new AgentBuilder({
    domain,
    registry,
    taskStore: fixture.taskStore,
    runtime: {
      ...fixture.runtime,
      appServer,
    },
    preparedAgents: fixture.preparedAgents,
  });
  const coordinator = builder.buildCoordinator();
  registry.bindThread(coordinator.agentId, "thread-coordinator");

  assert.ok(appServer.handler);
  const result = await appServer.handler({
    threadId: "thread-coordinator",
    turnId: "turn-1",
    callId: "call-1",
    namespace: VALIDATION_DOMAIN_TOOL_NAMESPACE,
    tool: GET_VALIDATION_STATE_SNAPSHOT_TOOL,
    arguments: {},
  });

  assert.equal(result.success, true);
  const payload = JSON.parse(result.contentItems[0]?.text ?? "{}") as {
    domainId?: string;
    snapshot?: {
      artifact_type?: string;
      current_state?: string;
      allowed_actions?: string[];
    };
  };
  assert.equal(payload.domainId, "validation");
  assert.equal(payload.snapshot?.artifact_type, "ValidationStateSnapshot");
  assert.equal(payload.snapshot?.current_state, "missing_bdd");
  assert.deepEqual(payload.snapshot?.allowed_actions, ["request_bdd", "request_user_input"]);
});

test("AgentTaskBackend reads and routes tasks through the shared task store", async () => {
  let verifier: ScoutAgent | undefined;
  let assignedTaskId: string | undefined;
  let requestIssued = false;
  const appServer = createFakeAppServer({
    onRunTurn: async (turn) => {
      if (requestIssued || turn.prompt !== "Verify this behavior." || !verifier || !assignedTaskId) return;
      requestIssued = true;
      verifier.runner.requestHumanInput({
        taskId: assignedTaskId,
        request: {
          requestId: "input-1",
          agentId: verifier.agentId,
          taskId: assignedTaskId,
          kind: "prompt_required",
          question: "Need expected result.",
          createdAt: new Date().toISOString(),
          status: "pending",
        },
      });
    },
  });
  const fixture = createAgentFixture("task-store-route", appServer);
  const domain = createStaticDomain("domain-task-store", []);
  const verifierMount = createMount(fixture.root, ScoutAgentRoles.Verifier);
  const verifierCommit = createAssetCommit(verifierMount);
  const agentBackend = new AgentBackend({
    appServer,
    runId: "run-task-store-route",
    registry: fixture.registry,
    taskStore: fixture.taskStore,
    eventBus: fixture.options.eventBus,
    agentProvider: {
      resolveWorker(input): ScoutAgent {
        return fixture.registry.resolveAgent(input.role);
      },
    },
    logger: fixture.options.logger,
    domain,
  });
  const builder = new AgentBuilder({
    domain,
    registry: fixture.registry,
    taskStore: fixture.taskStore,
    runtime: fixture.runtime,
    preparedAgents: {
      ...fixture.preparedAgents,
      [ScoutAgentRoles.Verifier]: {
        agentMount: verifierMount,
        assetCommit: verifierCommit,
      },
    },
  });
  verifier = builder.buildWorker(ScoutAgentRoles.Verifier);
  await verifier.start();

  const task = agentBackend.task.assignAgentTask({
    description: "Verify BDD",
    subagentType: ScoutAgentRoles.Verifier,
    prompt: "Verify this behavior.",
    isBackgrounded: true,
  });
  assignedTaskId = task.taskId;
  assert.equal(verifier.agentId, ScoutAgentRoles.Verifier);
  await (verifier.runner as WorkerRunner).runTasksToIdle();
  assert.equal(fixture.taskStore.getTask(task.taskId)?.status, AgentTaskStatuses.WaitingForHumanInput);

  const resumed = agentBackend.task.sendAgentMessage({
    target: task.taskId,
    message: "用户补充了 expected result。",
  });

  assert.equal(fixture.taskStore.getTask(task.taskId)?.status, AgentTaskStatuses.Running);
  assert.equal(resumed.steps?.[0]?.status, AgentTaskStepStatuses.WaitingForHumanInput);
  assert.equal(resumed.steps?.[0]?.humanInputRequest?.requestId, "input-1");
  assert.equal(fixture.taskStore.listTasks().length, 1);
  assert.equal(fixture.taskStore.listTasks()[0]?.taskId, task.taskId);
  assert.equal(fixture.taskStore.listTasks()[0]?.status, AgentTaskStatuses.Running);
});

test("AgentTaskBackend stores human input request and response on the current worker step", async () => {
  let verifier: ScoutAgent | undefined;
  let assignedTaskId: string | undefined;
  let requestIssued = false;
  const appServer = createFakeAppServer({
    onRunTurn: async (turn) => {
      if (requestIssued || turn.prompt !== "Verify this behavior." || !verifier || !assignedTaskId) return;
      requestIssued = true;
      verifier.runner.requestHumanInput({
        taskId: assignedTaskId,
        request: {
          requestId: "input-1",
          agentId: verifier.agentId,
          taskId: assignedTaskId,
          kind: "prompt_required",
          question: "Need expected result.",
          createdAt: new Date().toISOString(),
          status: "pending",
        },
      });
    },
  });
  const fixture = createAgentFixture("human-input-response", appServer);
  const verifierMount = createMount(fixture.root, ScoutAgentRoles.Verifier);
  const verifierCommit = createAssetCommit(verifierMount);
  const agentBackend = new AgentBackend({
    appServer,
    runId: "run-human-input-response",
    registry: fixture.registry,
    taskStore: fixture.taskStore,
    eventBus: fixture.options.eventBus,
    agentProvider: {
      resolveWorker(input): ScoutAgent {
        return fixture.registry.resolveAgent(input.role);
      },
    },
    logger: fixture.options.logger,
    domain: createStaticDomain("domain-human-input-response", []),
  });
  const builder = new AgentBuilder({
    domain: createStaticDomain("domain-human-input-response", []),
    registry: fixture.registry,
    taskStore: fixture.taskStore,
    runtime: fixture.runtime,
    preparedAgents: {
      ...fixture.preparedAgents,
      [ScoutAgentRoles.Verifier]: {
        agentMount: verifierMount,
        assetCommit: verifierCommit,
      },
    },
  });
  verifier = builder.buildWorker(ScoutAgentRoles.Verifier);
  await verifier.start();

  const task = agentBackend.task.assignAgentTask({
    description: "Verify BDD",
    subagentType: ScoutAgentRoles.Verifier,
    prompt: "Verify this behavior.",
    isBackgrounded: true,
  });
  assignedTaskId = task.taskId;
  assert.equal(verifier.agentId, ScoutAgentRoles.Verifier);
  await (verifier.runner as WorkerRunner).runTasksToIdle();
  assert.equal(fixture.taskStore.getTask(task.taskId)?.status, AgentTaskStatuses.WaitingForHumanInput);

  const updated = agentBackend.task.handleHumanInputResponse({
    taskId: task.taskId,
    requestId: "input-1",
    response: "Expected result is A.",
  });

  assert.equal(updated.status, AgentTaskStatuses.Running);
  assert.equal(updated.steps?.length, 1);
  assert.equal(updated.steps?.[0]?.status, AgentTaskStepStatuses.WaitingForHumanInput);
  assert.equal(updated.steps?.[0]?.humanInputRequest?.requestId, "input-1");
  assert.equal(updated.steps?.[0]?.humanInputRequest?.status, "answered");
  assert.equal(updated.steps?.[0]?.humanInputResponse?.response, "Expected result is A.");
  assert.equal(verifier.runner.snapshot().pendingMessageCount, 0);
});

test("AgentOrchestrator maps task human input events to system interrupts", async () => {
  let verifier: ScoutAgent | undefined;
  let assignedTaskId: string | undefined;
  let requestIssued = false;
  const appServer = createFakeAppServer({
    onRunTurn: async (turn) => {
      if (requestIssued || turn.prompt !== "Need human input" || !verifier || !assignedTaskId) return;
      requestIssued = true;
      verifier.runner.requestHumanInput({
        taskId: assignedTaskId,
        request: {
          requestId: "input-1",
          agentId: verifier.agentId,
          taskId: assignedTaskId,
          kind: "prompt_required",
          question: "Need expected result.",
          createdAt: new Date().toISOString(),
          status: "pending",
        },
      });
    },
  });
  const fixture = createAgentFixture("orchestrator-human-input", appServer);
  const domain = createStaticDomain("domain-orchestrator-human-input", []);
  const verifierMount = createMount(fixture.root, ScoutAgentRoles.Verifier);
  const verifierCommit = createAssetCommit(verifierMount);
  const eventBus = fixture.options.eventBus;
  const taskEvents: AgentTaskSystemEvent[] = [];
  const interruptEvents: Array<ScoutEvent<SystemInterruptEventPayload>> = [];
  eventBus.subscribe(SystemEvents.task, (event) => {
    taskEvents.push(event as AgentTaskSystemEvent);
  });
  eventBus.subscribe<SystemInterruptEventPayload>(SystemEvents.interrupt, (event) => {
    interruptEvents.push(event);
  });
  const agentBackend = new AgentBackend({
    appServer,
    runId: "run-orchestrator-human-input",
    registry: fixture.registry,
    taskStore: fixture.taskStore,
    eventBus,
    agentProvider: {
      resolveWorker(input): ScoutAgent {
        return fixture.registry.resolveAgent(input.role);
      },
    },
    logger: fixture.options.logger,
    domain,
  });
  const builder = new AgentBuilder({
    domain,
    registry: fixture.registry,
    taskStore: fixture.taskStore,
    runtime: fixture.runtime,
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
  verifier = builder.buildWorker(ScoutAgentRoles.Verifier);
  await verifier.start();
  const interactionPort = new CapturingInteractionPort("Expected result is A.");
  const interactionGateway = new InteractionGateway({
    eventBus,
    interactionPort,
    logger: fixture.options.logger,
  });
  interactionGateway.start();
  const task = agentBackend.task.assignAgentTask({
    description: "Verify BDD",
    subagentType: ScoutAgentRoles.Verifier,
    prompt: "Need human input",
    isBackgrounded: true,
  });
  assignedTaskId = task.taskId;
  assert.equal(verifier.agentId, ScoutAgentRoles.Verifier);
  const orchestrator = new AgentOrchestrator({
    eventBus,
  });
  orchestrator.start();

  await (verifier.runner as WorkerRunner).runTasksToIdle();
  await waitFor(() => {
    const coordinatorInterruptKeys = readCoordinatorInterruptKeys(appServer.turnInputs);
    return coordinatorInterruptKeys.includes(SystemEvents.interrupt.raised.routeKey)
      && coordinatorInterruptKeys.includes(SystemEvents.interrupt.resolved.routeKey);
  });
  orchestrator.stop();
  interactionGateway.stop();

  const taskKeys = taskEvents.map((event) => event.key.routeKey);
  const interruptKeys = interruptEvents.map((event) => event.key.routeKey);
  assert.ok(taskKeys.includes(SystemEvents.task.humanInputRequested.routeKey));
  assert.ok(taskKeys.includes(SystemEvents.task.humanInputResponded.routeKey));
  assert.ok(interruptKeys.includes(SystemEvents.interrupt.raised.routeKey));
  assert.ok(interruptKeys.includes(SystemEvents.interrupt.resolved.routeKey));
  const interruptRaised = interruptEvents.find((event) => SystemEvents.interrupt.raised.is(event));
  const interruptResolved = interruptEvents.find((event) => SystemEvents.interrupt.resolved.is(event));
  assert.ok(interruptRaised);
  assert.ok(interruptResolved);
  assert.equal("request" in interruptRaised.payload, false);
  assert.equal("response" in interruptResolved.payload, false);
  assert.deepEqual(interactionPort.requests.map((request) => request.id), ["input-1"]);
  const storedTask = fixture.taskStore.getTask(task.taskId);
  assert.ok(storedTask);
  assert.equal(storedTask.status, AgentTaskStatuses.Running);
  assert.equal(storedTask.steps?.[0]?.humanInputRequest?.status, "answered");
  assert.equal(storedTask.steps?.[0]?.humanInputResponse?.response, "Expected result is A.");
  const coordinatorPrompts = appServer.turnInputs
    .map((turn) => turn.prompt)
    .filter((prompt): prompt is string => isCoordinatorMessagesPrompt(prompt));
  assert.ok(coordinatorPrompts.length > 0);
  const coordinatorInterruptKeys = readCoordinatorInterruptKeys(appServer.turnInputs);
  assert.ok(coordinatorInterruptKeys.includes(SystemEvents.interrupt.raised.routeKey));
  assert.ok(coordinatorInterruptKeys.includes(SystemEvents.interrupt.resolved.routeKey));
  for (const coordinatorPrompt of coordinatorPrompts) {
    assert.doesNotMatch(coordinatorPrompt, /<runtime-events>|<human-input-request-notification>/);
  }
});

test("AgentTaskStore snapshots are immutable from callers", () => {
  const fixture = createAgentFixture("task-store-immutable");
  const task = fixture.taskStore.addTask({
    type: "local_agent",
    taskId: "task-immutable",
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
  appServer = createFakeAppServer(),
): {
  root: string;
  mount: CodexMount;
  assetCommit: AssetCommit;
  options: ScoutAgentOptions;
  runtime: AgentBuilderRuntime;
  preparedAgents: PreparedAgentInputs;
  registry: AgentRegistry;
  taskStore: AgentTaskStore;
} {
  const root = mkdtempSync(join(tmpdir(), `scout-${name}-`));
  const mount = createMount(root, ScoutAgentRoles.Coordinator);
  const assetCommit = createAssetCommit(mount);
  const taskStore = new AgentTaskStore();
  const eventBus = new InMemoryEventBus();
  const registry = new AgentRegistry({
    logger: createNoopLogger(),
  });
  const options: ScoutAgentOptions = {
    repoRoot: root,
    appServer: appServer as ScoutAgentOptions["appServer"],
    contextBundle: buildRunContextBundle({
      runId: "run-test",
      assetCommit,
    }),
    agentMount: mount,
    assetCommit,
    logger: createNoopLogger(),
    taskStore,
    eventBus,
    registry,
  };
  const runtime = {
    repoRoot: options.repoRoot,
    appServer: options.appServer,
    contextBundle: options.contextBundle,
    logger: options.logger,
    eventBus,
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
    runtime,
    preparedAgents,
    registry,
    taskStore,
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
  readonly progress: RuntimeProgressEvent[] = [];
  readonly notifications: AgentTaskSystemEvent[] = [];
  readonly requests: HumanInputRequest[] = [];

  constructor(private readonly responseText: string) {}

  async disclose(event: RuntimeDisclosureEvent): Promise<void> {
    this.disclosures.push(event);
  }

  async publishProgress(event: RuntimeProgressEvent): Promise<void> {
    this.progress.push(event);
  }

  async notify(event: AgentTaskSystemEvent): Promise<void> {
    this.notifications.push(event);
  }

  async publishAgentMessage(): Promise<void> {
    // test adapter captures task notifications and input requests only
  }

  async requestInput(request: HumanInputRequest): Promise<{ requestId: string; text: string }> {
    this.requests.push(request);
    return {
      requestId: request.id,
      text: this.responseText,
    };
  }
}

function createNoopLogger(): ScoutAgentOptions["logger"] {
  return {
    registerAgentLogRoot: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as ScoutAgentOptions["logger"];
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(predicate(), true);
}

function readCoordinatorInterruptKeys(turnInputs: Array<{ prompt?: string }>): string[] {
  return turnInputs
    .map((turn) => turn.prompt)
    .filter((prompt): prompt is string => isCoordinatorMessagesPrompt(prompt))
    .flatMap((prompt) => {
      const input = JSON.parse(prompt) as {
        messages?: Array<{ interrupt?: { key?: string } }>;
      };
      return input.messages
        ?.map((message) => message.interrupt?.key)
        .filter((key): key is string => typeof key === "string") ?? [];
    });
}

function isCoordinatorMessagesPrompt(prompt: string | undefined): prompt is string {
  if (typeof prompt !== "string") return false;
  try {
    return JSON.parse(prompt).type === "coordinator_messages";
  } catch {
    return false;
  }
}

function createFakeAppServer(options: {
  onRunTurn?: (turn: { prompt?: string }) => void | Promise<void>;
} = {}): ScoutAgentOptions["appServer"] & {
  handler?: DynamicToolCallHandler;
  turnInputs: Array<{ prompt?: string }>;
} {
  const timelineHandlers: Array<(...args: never[]) => void> = [];
  const appServer = {
    turnInputs: [] as Array<{ prompt?: string }>,
    setDynamicToolCallHandler(handler: DynamicToolCallHandler): void {
      appServer.handler = handler;
    },
    onTimeline(handler: (...args: never[]) => void): void {
      timelineHandlers.push(handler);
    },
    startThread: async () => ({
      threadId: "thread-test",
      response: {
        thread: { id: "thread-test" },
      },
    }),
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
    runTurn: async (turnInput: { prompt?: string }) => {
      appServer.turnInputs.push(turnInput);
      await options.onRunTurn?.(turnInput);
      return {
        finalResponse: "",
        response: {},
      };
    },
  } as unknown as ScoutAgentOptions["appServer"] & {
    handler?: DynamicToolCallHandler;
    turnInputs: Array<{ prompt?: string }>;
  };
  return appServer;
}
