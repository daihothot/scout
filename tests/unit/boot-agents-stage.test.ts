import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BootAgentsStage,
  BootEnvironmentStage,
} from "../../src/run/boot/index.js";
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

const repoRoot = process.cwd();

test("BootAgentsStage starts all role threads in parallel on the installed RunScope", async (t) => {
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
    terminate: async () => undefined,
  });
  scope.setAppServer(appServer);
  const releaseScope = installRunScope(scope);
  const environment = new BootEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  });
  const stage = new BootAgentsStage();
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
    scope.agentRegistry.resolveAgent(ScoutAgentRoles.Coordinator).threadSnapshot?.threadPreflight?.result.status,
    "passed",
  );
  assert.deepEqual(scope.taskStore.listTasks(), []);
});

function createAppServer(onStartThread: (cwd: string) => string): CodexAppServerClient {
  return {
    startThread: async (options: { cwd: string }) => {
      const threadId = onStartThread(options.cwd);
      return {
        threadId,
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
