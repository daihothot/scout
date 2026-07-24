import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentsStage,
} from "../../src/run/lifecycle/index.js";
import { PrepareEnvironmentStage } from "../../src/run/startup/index.js";
import {
  installRunScope,
  RunScope,
} from "../../src/run/run-scope.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import type { ScoutDomain } from "../../src/domain/index.js";
import type { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";
import type { Logger } from "../../src/core/logging/index.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/protocol/port.js";
import { createTestRunPersistence } from "../helpers/run-persistence.js";

const repoRoot = process.cwd();

test("AgentsStage starts all role threads in parallel on the installed RunScope", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-boot-agents-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(root, "assets", "codex"), {
    recursive: true,
  });
  const runId = "boot-agents-test";
  const startedThreads: string[] = [];
  const appServer = createAppServer((cwd) => {
    const role = Object.values(ScoutAgentRoles).find((candidate) =>
      cwd.includes(`${candidate}/mount`)
    ) ?? "unknown";
    const threadId = `thread-${role}`;
    startedThreads.push(threadId);
    return threadId;
  });
  const scope = new RunScope({
    runId,
    repoRoot: root,
    logger: createNoopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: createStaticDomain(),
    ...createTestRunPersistence(t, runId, root),
    terminate: async () => undefined,
  });
  scope.setAppServer(appServer);
  const releaseScope = installRunScope(scope);
  const environment = new PrepareEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  });
  const stage = new AgentsStage();
  t.after(async () => {
    await stage.stop("test_cleanup");
    scope.clearAppServer(appServer);
    releaseScope();
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
    Object.values(ScoutAgentRoles).sort(),
  );
  assert.equal(
    scope.agentRegistry.resolveAgentByThreadId("thread-verifier"),
    scope.agentRegistry.resolveAgent(ScoutAgentRoles.Verifier),
  );
  assert.equal(
    scope.agentRegistry.resolveAgent(ScoutAgentRoles.Coordinator).threadPreflightSnapshot?.result.status,
    "passed",
  );
  assert.deepEqual(scope.taskStore.listTasks(), []);

  await stage.stop("test_shutdown");
  for (const agent of scope.agentRegistry.listAgents()) {
    assert.equal(agent.threadSnapshot?.status, "closed");
    assert.equal(agent.threadSnapshot?.closeReason, "test_shutdown");
  }
});

test("AgentsStage closes started threads when another Agent fails to start", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-boot-agents-failure-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(root, "assets", "codex"), {
    recursive: true,
  });
  const runId = "boot-agents-failure-test";
  const appServer = createAppServer((cwd) => {
    const role = Object.values(ScoutAgentRoles).find((candidate) =>
      cwd.includes(`${candidate}/mount`)
    ) ?? "unknown";
    if (role === ScoutAgentRoles.Validator) throw new Error("validator thread failed");
    return `thread-${role}`;
  });
  const scope = new RunScope({
    runId,
    repoRoot: root,
    logger: createNoopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: createStaticDomain(),
    ...createTestRunPersistence(t, runId, root),
    terminate: async () => undefined,
  });
  scope.setAppServer(appServer);
  const releaseScope = installRunScope(scope);
  const environment = new PrepareEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  });
  const stage = new AgentsStage();
  t.after(async () => {
    await stage.stop("test_cleanup");
    scope.clearAppServer(appServer);
    releaseScope();
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
    scope.agentRegistry.resolveAgent(ScoutAgentRoles.Validator).threadSnapshot,
    undefined,
  );
});

function createAppServer(onStartThread: (cwd: string) => string): CodexAppServerClient {
  return {
    startThread: async (options: { cwd: string }) => {
      const threadId = onStartThread(options.cwd);
      return {
        threadId,
        startInput: {
          cwd: options.cwd,
          approvalPolicy: "never",
          sandbox: "workspace-write",
          ephemeral: true,
        },
        response: { thread: { id: threadId } },
      };
    },
    request: async (_method: string, params: { threadId?: string }) => ({
      threadId: params.threadId,
      servers: [],
    }),
  } as unknown as CodexAppServerClient;
}

function createStaticDomain(): ScoutDomain {
  return {
    domainId: "test",
    name: "test",
    dynamicToolsForRole: () => [],
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
