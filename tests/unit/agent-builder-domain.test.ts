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
import { AgentRegistry } from "../../src/agent/lifecycle/agent-registry.js";
import { AgentThreadLifecycle } from "../../src/agent/lifecycle/agent-thread-lifecycle.js";
import { AgentTaskStore } from "../../src/agent/task/agent-task-store.js";
import { CoordinatorAgent } from "../../src/agent/roles/coordinator-agent.js";
import { ResearcherAgent } from "../../src/agent/roles/researcher-agent.js";
import type { ScoutAgent, ScoutAgentOptions } from "../../src/agent/core/scout-agent.js";
import {
  SYSTEM_TOOL_NAMESPACE,
} from "../../src/agent/tools/system-tools.js";
import { ScoutAgentRoles, type AgentDynamicToolSpec } from "../../src/agent/model/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import type { DynamicToolCallHandler } from "../../src/agent-server/types.js";
import type { AssetCommit, CodexMount } from "../../src/asset-store/index.js";
import type { ScoutDomain } from "../../src/domain/index.js";
import { ValidationDomain } from "../../src/domain/index.js";
import {
  GET_VALIDATION_STATE_SNAPSHOT_TOOL,
  VALIDATION_DOMAIN_TOOL_NAMESPACE,
} from "../../src/domain/validation/tools/index.js";
import { buildRunContextBundle } from "../../src/run/types.js";

test("AgentBuilder creates a coordinator with system and single-domain tools", () => {
  const fixture = createAgentFixture("builder-coordinator");
  const domainTool = buildDomainTool("domain-a");
  const builder = new AgentBuilder({
    domain: createStaticDomain("domain-a", [domainTool]),
    registry: fixture.registry,
    lifecycle: fixture.lifecycle,
    taskStore: fixture.taskStore,
    runtime: fixture.runtime,
    preparedAgents: fixture.preparedAgents,
  });

  const agent = builder.buildCoordinator();
  const tools = agent.spec.dynamicTools ?? [];

  assert.ok(agent instanceof CoordinatorAgent);
  assert.equal(fixture.registry.listAgents()[0], agent);
  assert.ok(tools.some((tool) => tool.namespace === SYSTEM_TOOL_NAMESPACE && tool.name === "AgentTool"));
  assert.ok(tools.some((tool) => tool.namespace === SYSTEM_TOOL_NAMESPACE && tool.name === "SendMessage"));
  assert.ok(tools.some((tool) => tool.namespace === SYSTEM_TOOL_NAMESPACE && tool.name === "RequestHumanInput"));
  assert.ok(tools.some((tool) => tool.namespace === "domain-a" && tool.name === "DomainProbe"));
  assert.equal(tools.some((tool) => tool.namespace === "domain-b"), false);
});

test("AgentBuilder creates and reuses workers while preserving domain tool scope", () => {
  const fixture = createAgentFixture("builder-worker");
  const researcherMount = createMount(fixture.root, ScoutAgentRoles.Researcher);
  const researcherCommit = createAssetCommit(researcherMount);
  const builder = new AgentBuilder({
    domain: createStaticDomain("domain-worker", [buildDomainTool("domain-worker")]),
    registry: fixture.registry,
    lifecycle: fixture.lifecycle,
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

  const agent = builder.getOrCreateWorker({ role: ScoutAgentRoles.Researcher });
  const tools = agent.spec.dynamicTools ?? [];

  assert.ok(agent instanceof ResearcherAgent);
  assert.equal(builder.getOrCreateWorker({ role: ScoutAgentRoles.Researcher }), agent);
  assert.equal(fixture.registry.resolveAgent(ScoutAgentRoles.Researcher), agent);
  assert.ok(tools.some((tool) => tool.namespace === SYSTEM_TOOL_NAMESPACE && tool.name === "RequestHumanInput"));
  assert.deepEqual(tools.filter((tool) => tool.namespace !== "domain-worker").map((tool) => tool.name), ["RequestHumanInput"]);
  assert.equal(tools.some((tool) => tool.name === "AgentTool"), false);
  assert.equal(tools.some((tool) => tool.name === "SendMessage"), false);
  assert.ok(tools.some((tool) => tool.namespace === "domain-worker" && tool.name === "DomainProbe"));
});

test("AgentRegistry indexes registered agents and thread bindings without owning lifecycle", () => {
  const fixture = createAgentFixture("registry-bind");
  const builder = new AgentBuilder({
    domain: createStaticDomain("domain-registry", []),
    registry: fixture.registry,
    lifecycle: fixture.lifecycle,
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

test("AgentThreadLifecycle starts a thread, runs preflight, and binds it to registry", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("lifecycle-start", appServer);
  const builder = new AgentBuilder({
    domain: createStaticDomain("domain-lifecycle", []),
    registry: fixture.registry,
    lifecycle: fixture.lifecycle,
    taskStore: fixture.taskStore,
    runtime: fixture.runtime,
    preparedAgents: fixture.preparedAgents,
  });
  const agent = builder.buildCoordinator();

  const { thread, preflight } = await agent.startWithPreflight();

  assert.equal(thread.threadId, "thread-test");
  assert.equal(preflight.result.status, "passed");
  assert.equal(fixture.registry.resolveAgentByThreadId("thread-test"), agent);
  assert.deepEqual(fixture.lifecycle.listStartedAgents().map((item) => item.threadId), ["thread-test"]);
  assert.deepEqual(fixture.lifecycle.listThreadPreflights().map((item) => item.threadId), ["thread-test"]);
});

test("AgentToolBackend routes non-system dynamic tools to the registered domain", async () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("domain-route", appServer);
  const domain = new ValidationDomain({
    runId: "run-domain-route",
  });
  const registry = fixture.registry;
  const lifecycle = fixture.lifecycle;
  let builder: AgentBuilder | undefined;
  const agentBackend = new AgentBackend({
    appServer,
    runId: "run-domain-route",
    ledgerRoot: fixture.mount.artifactRoot,
    registry,
    lifecycle,
    taskStore: fixture.taskStore,
    eventBus: fixture.options.eventBus,
    agentProvider: {
      getOrCreateWorker(input): ScoutAgent {
        if (!builder) throw new Error("AgentBuilder is not initialized.");
        return builder.getOrCreateWorker(input);
      },
    },
    logger: fixture.options.logger,
    domain,
  });
  builder = new AgentBuilder({
    domain,
    registry,
    lifecycle,
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

test("AgentTaskBackend reads and routes tasks through the shared task store", () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("task-store-route", appServer);
  const domain = createStaticDomain("domain-task-store", []);
  const verifierMount = createMount(fixture.root, ScoutAgentRoles.Verifier);
  const verifierCommit = createAssetCommit(verifierMount);
  let builder: AgentBuilder | undefined;
  const agentBackend = new AgentBackend({
    appServer,
    runId: "run-task-store-route",
    ledgerRoot: fixture.mount.artifactRoot,
    registry: fixture.registry,
    lifecycle: fixture.lifecycle,
    taskStore: fixture.taskStore,
    eventBus: fixture.options.eventBus,
    agentProvider: {
      getOrCreateWorker(input): ScoutAgent {
        if (!builder) throw new Error("AgentBuilder is not initialized.");
        return builder.getOrCreateWorker(input);
      },
    },
    logger: fixture.options.logger,
    domain,
  });
  builder = new AgentBuilder({
    domain,
    registry: fixture.registry,
    lifecycle: fixture.lifecycle,
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

  const task = agentBackend.task.assignAgentTask({
    description: "Verify BDD",
    subagentType: ScoutAgentRoles.Verifier,
    prompt: "Verify this behavior.",
    isBackgrounded: true,
  });
  const verifier = fixture.registry.resolveAgent(ScoutAgentRoles.Verifier);
  verifier.task.requestUserInput({
    taskId: task.taskId,
    request: {
      requestId: "input-1",
      agentId: verifier.agentId,
      taskId: task.taskId,
      kind: "prompt_required",
      question: "Need expected result.",
      createdAt: new Date().toISOString(),
      status: "pending",
    },
  });

  const resumed = agentBackend.task.sendAgentMessage({
    target: task.taskId,
    message: "用户补充了 expected result。",
  });

  assert.equal(fixture.taskStore.getTask(task.taskId)?.status, "running");
  assert.equal(resumed.userInputRequest, undefined);
  assert.equal(agentBackend.getLedger().tasks.length, 1);
  assert.equal(agentBackend.getLedger().tasks[0]?.taskId, task.taskId);
  assert.equal(agentBackend.getLedger().tasks[0]?.status, "running");
});

test("AgentTaskBackend records human input response without resuming worker task", () => {
  const appServer = createFakeAppServer();
  const fixture = createAgentFixture("human-input-response", appServer);
  const verifierMount = createMount(fixture.root, ScoutAgentRoles.Verifier);
  const verifierCommit = createAssetCommit(verifierMount);
  let builder: AgentBuilder | undefined;
  const agentBackend = new AgentBackend({
    appServer,
    runId: "run-human-input-response",
    ledgerRoot: fixture.mount.artifactRoot,
    registry: fixture.registry,
    lifecycle: fixture.lifecycle,
    taskStore: fixture.taskStore,
    eventBus: fixture.options.eventBus,
    agentProvider: {
      getOrCreateWorker(input): ScoutAgent {
        if (!builder) throw new Error("AgentBuilder is not initialized.");
        return builder.getOrCreateWorker(input);
      },
    },
    logger: fixture.options.logger,
    domain: createStaticDomain("domain-human-input-response", []),
  });
  builder = new AgentBuilder({
    domain: createStaticDomain("domain-human-input-response", []),
    registry: fixture.registry,
    lifecycle: fixture.lifecycle,
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

  const task = agentBackend.task.assignAgentTask({
    description: "Verify BDD",
    subagentType: ScoutAgentRoles.Verifier,
    prompt: "Verify this behavior.",
    isBackgrounded: true,
  });
  const verifier = fixture.registry.resolveAgent(ScoutAgentRoles.Verifier);
  verifier.task.requestUserInput({
    taskId: task.taskId,
    request: {
      requestId: "input-1",
      agentId: verifier.agentId,
      taskId: task.taskId,
      kind: "prompt_required",
      question: "Need expected result.",
      createdAt: new Date().toISOString(),
      status: "pending",
    },
  });

  const updated = agentBackend.task.handleUserInputResponse({
    taskId: task.taskId,
    requestId: "input-1",
    response: "Expected result is A.",
  });

  assert.equal(updated.status, "waiting_for_coordinator");
  assert.equal(updated.userInputRequest?.status, "answered");
  assert.equal(updated.humanInputRequests?.[0]?.status, "answered");
  assert.equal(updated.humanInputResponses?.[0]?.response, "Expected result is A.");
  assert.equal(verifier.task.snapshot().pendingMessageCount, 0);
});

test("AgentTaskStore snapshots are immutable from callers", () => {
  const fixture = createAgentFixture("task-store-immutable");
  const task = fixture.taskStore.addTask({
    type: "local_agent",
    taskId: "task-immutable",
    agentId: "agent-1",
    role: ScoutAgentRoles.Verifier,
    description: "Immutable task",
    prompt: "Do work",
    selectedAgent: ScoutAgentRoles.Verifier,
    status: "queued",
    isBackgrounded: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  task.status = "failed";
  const stored = fixture.taskStore.requireTask("task-immutable");

  assert.equal(stored.status, "queued");
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
  lifecycle: AgentThreadLifecycle;
  taskStore: AgentTaskStore;
} {
  const root = mkdtempSync(join(tmpdir(), `scout-${name}-`));
  const mount = createMount(root, ScoutAgentRoles.Coordinator);
  const assetCommit = createAssetCommit(mount);
  const taskStore = new AgentTaskStore();
  const eventBus = new InMemoryEventBus();
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
  };
  const registry = new AgentRegistry({
    logger: options.logger,
  });
  const lifecycle = new AgentThreadLifecycle({
    appServer: options.appServer,
    registry,
    logger: options.logger,
  });
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
    lifecycle,
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
    mcpServerBindings: {},
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

function createNoopLogger(): ScoutAgentOptions["logger"] {
  return {
    registerAgentLogRoot: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as ScoutAgentOptions["logger"];
}

function createFakeAppServer(): ScoutAgentOptions["appServer"] & {
  handler?: DynamicToolCallHandler;
} {
  const timelineHandlers: Array<(...args: never[]) => void> = [];
  const appServer = {
    setDynamicToolCallHandler(handler: DynamicToolCallHandler): void {
      appServer.handler = handler;
    },
    onTimeline(handler: (...args: never[]) => void): void {
      timelineHandlers.push(handler);
    },
    startThread: async () => ({
      threadId: "thread-test",
      response: {},
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
    runTurn: async () => ({
      finalResponse: "",
      response: {},
    }),
  } as unknown as ScoutAgentOptions["appServer"] & {
    handler?: DynamicToolCallHandler;
  };
  return appServer;
}
