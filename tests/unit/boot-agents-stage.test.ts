import { testWorkflowParticipant } from "../helpers/workflow-participant.js";
import { AgentDynamicToolBackend } from "../../src/agent/backend/dynamic-tool/agent-dynamic-tool-backend.js";
import { AgentTimelineBackend } from "../../src/agent/backend/timeline/agent-timeline-backend.js";
import { AgentRequestBackend } from "../../src/agent/backend/request/agent-request-backend.js";
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentsStage,
  OrchestratorStage,
} from "../../src/run/lifecycle/index.js";
import { PrepareEnvironmentStage } from "../../src/run/startup/index.js";
import {
  installRunScope,
  RunScope,
} from "../../src/run/run-scope.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import {
  BaseDomain,
  DomainAgentBackend,
  ScoutDomainId,
  type ScoutDomain,
} from "../../src/domain/index.js";
import type { ExecutionPlatformPort } from "../../src/execution/index.js";
import type {
  CodexAppServerClient,
  ThreadStartOptions,
} from "../../src/agent-server/codex/app-server-client.js";
import type { Logger } from "../../src/core/logging/index.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/protocol/port.js";
import {
  createTestRunPersistence,
  createDefaultTestGraph,
} from "../helpers/run-persistence.js";

const scoutRoot = process.cwd();

test("AgentsStage starts all role threads in parallel on the installed RunScope", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-boot-agents-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  cpSync(join(scoutRoot, "assets", "scout"), join(root, "assets", "scout"), {
    recursive: true,
  });
  cpSync(
    join(scoutRoot, "assets", "agent-runtimes"),
    join(root, "assets", "agent-runtimes"),
    { recursive: true },
  );
  const runId = "boot-agents-test";
  const startedThreads: string[] = [];
  const appServer = createAppServer((options) => {
    const role = createDefaultTestGraph().snapshot().roles.map((role) => role.name).find((candidate) =>
      options.cwd.includes(`${candidate}/mount`)
    ) ?? "unknown";
    const threadId = `thread-${role}`;
    startedThreads.push(threadId);
    return threadId;
  });
  const domain = createStaticDomain();
  const scope = new RunScope({
    runId,
    scoutRoot: root,
    logger: createNoopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    ...await createTestRunPersistence(t, runId, root, undefined, join(root, "run", runId)),
    terminate: async () => undefined,
  });
  scope.setExecutionSystem(unavailableExecutionSystem());
  scope.setAppServer(appServer);
  const releaseScope = installRunScope(scope);
  const orchestratorStage = new OrchestratorStage();
  // This fixture verifies Thread startup, not protocol subscriptions.
  t.mock.method(AgentTimelineBackend.prototype, "start", () => undefined);
  t.mock.method(AgentDynamicToolBackend.prototype, "start", () => undefined);
  t.mock.method(AgentRequestBackend.prototype, "start", () => undefined);
  await orchestratorStage.start();
  scope.domainRegistry.register(new BaseDomain());
  scope.domainRegistry.register(domain);
  const environment = new PrepareEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  });
  const stage = new AgentsStage();
  t.after(async () => {
    await stage.stop("test_cleanup");
    await orchestratorStage.stop();
    scope.clearAppServer(appServer);
    releaseScope();
    rmSync(root, { recursive: true, force: true });
  });

  await environment.start();
  await stage.start();

  assert.deepEqual(startedThreads.sort(), [
    "thread-coordinator",
    "thread-researcher",
    "thread-validator",
    "thread-verifier",
  ]);
  assert.deepEqual(
    scope.agentRegistry.listAgents().map((agent) => agent.role).sort(),
    createDefaultTestGraph().snapshot().roles.map((role) => role.name).sort(),
  );
  assert.ok(scope.agentRegistry.listAgents().every((agent) =>
    agent.threadSnapshot?.startInput.ephemeral === false
  ));
  assert.equal(
    scope.agentRegistry.resolveAgentByThreadId("thread-verifier"),
    scope.agentRegistry.resolveAgent("verifier"),
  );
  assert.equal(
    scope.agentRegistry.resolveAgent("coordinator").threadPreflightSnapshot?.result.status,
    "passed",
  );
  assert.deepEqual(scope.agentOrchestrator.taskStore.listTasks(), []);

  await stage.stop("test_shutdown");
  for (const agent of scope.agentRegistry.listAgents()) {
    assert.equal(agent.threadSnapshot?.status, "closed");
    assert.equal(agent.threadSnapshot?.closeReason, "test_shutdown");
  }
});

test("AgentsStage closes started threads when another Agent fails to start", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-boot-agents-failure-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  cpSync(join(scoutRoot, "assets", "scout"), join(root, "assets", "scout"), {
    recursive: true,
  });
  cpSync(
    join(scoutRoot, "assets", "agent-runtimes"),
    join(root, "assets", "agent-runtimes"),
    { recursive: true },
  );
  const runId = "boot-agents-failure-test";
  const appServer = createAppServer((options) => {
    const role = createDefaultTestGraph().snapshot().roles.map((role) => role.name).find((candidate) =>
      options.cwd.includes(`${candidate}/mount`)
    ) ?? "unknown";
    if (role === "validator") throw new Error("validator thread failed");
    return `thread-${role}`;
  });
  const domain = createStaticDomain();
  const scope = new RunScope({
    runId,
    scoutRoot: root,
    logger: createNoopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    ...await createTestRunPersistence(t, runId, root, undefined, join(root, "run", runId)),
    terminate: async () => undefined,
  });
  scope.setExecutionSystem(unavailableExecutionSystem());
  scope.setAppServer(appServer);
  const releaseScope = installRunScope(scope);
  const orchestratorStage = new OrchestratorStage();
  // This fixture verifies Thread startup, not protocol subscriptions.
  t.mock.method(AgentTimelineBackend.prototype, "start", () => undefined);
  t.mock.method(AgentDynamicToolBackend.prototype, "start", () => undefined);
  t.mock.method(AgentRequestBackend.prototype, "start", () => undefined);
  await orchestratorStage.start();
  scope.domainRegistry.register(new BaseDomain());
  scope.domainRegistry.register(domain);
  const environment = new PrepareEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  });
  const stage = new AgentsStage();
  t.after(async () => {
    await stage.stop("test_cleanup");
    await orchestratorStage.stop();
    scope.clearAppServer(appServer);
    releaseScope();
    rmSync(root, { recursive: true, force: true });
  });

  await environment.start();
  await assert.rejects(stage.start(), /validator thread failed/);

  const startedAgents = scope.agentRegistry.listAgents().filter((agent) => agent.threadSnapshot);
  assert.equal(startedAgents.length, 3);
  for (const agent of startedAgents) {
    assert.equal(agent.threadSnapshot?.status, "closed");
    assert.equal(agent.threadSnapshot?.closeReason, "agent_startup_failed");
  }
  assert.equal(
    scope.agentRegistry.resolveAgent("validator").threadSnapshot,
    undefined,
  );
});

function createAppServer(
  onStartThread: (options: ThreadStartOptions) => string,
): CodexAppServerClient {
  return {
    startThread: async (options: ThreadStartOptions) => {
      const threadId = onStartThread(options);
      return {
        threadId,
        startInput: {
          cwd: options.cwd,
          approvalPolicy: "never",
          permissions: options.permissions,
          ephemeral: options.ephemeral ?? true,
        },
        response: { thread: { id: threadId } },
      };
    },
    request: async (_method: string, params: { threadId?: string }) => ({
      threadId: params.threadId,
      servers: [],
    }),
    threadSnapshot: () => undefined,
    interruptTurn: async () => ({}),
  } as unknown as CodexAppServerClient;
}

function unavailableExecutionSystem(): ExecutionPlatformPort {
  const unavailable = {
    ok: false as const,
    code: "test_execution_unavailable",
    message: "Execution is not used by AgentsStage tests.",
  };
  return {
    identify: async () => unavailable,
    launch: async () => unavailable,
    shutdown: async () => unavailable,
  };
}

function createStaticDomain(): ScoutDomain {
  return {
    ...testWorkflowParticipant,
    description: { id: ScoutDomainId.Rbt, name: "Test Domain" },
    backend: new class extends DomainAgentBackend {
      override async handleDynamicToolCall() { return undefined; }
    }(),
  };
}

function createNoopLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}
