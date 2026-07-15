import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BootClientsStage } from "../../src/run/boot/index.js";
import type { CodexAppServerClientBundle } from "../../src/agent-server/codex/app-server-factory.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import type { Logger } from "../../src/core/logging/index.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/protocol/port.js";
import {
  installRunScope,
  RunScope,
} from "../../src/run/run-scope.js";

const repoRoot = process.cwd();

test("BootClientsStage creates the isolated app-server session and owns its stop", async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-boot-clients-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });

  const runId = "boot-clients-test";
  const scope = new RunScope({
    runId,
    repoRoot: fixtureRoot,
    logger: noopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: testDomain(),
    terminate: async () => undefined,
  });
  const releaseScope = installRunScope(scope);
  let sessionStarted = false;
  let closeCount = 0;
  const clientOptions: Array<{
    isolatedHome: string;
    isolatedCodexHome: string;
    configToml: string;
    providerName: string;
    stderrLogPath: string;
    transportLogPath?: string;
    rootPlan: unknown;
    mountRoots?: string[];
    trustedRoots?: string[];
    defaultWritableRoots?: string[];
  }> = [];
  const stage = new BootClientsStage({
    createAppServerClient: (options) => {
      clientOptions.push(options);
      return {
        client: {
          startSession: async () => {
            sessionStarted = true;
          },
          close: () => {
            closeCount += 1;
          },
        },
        isolatedHome: options.isolatedHome,
        isolatedCodexHome: options.isolatedCodexHome,
        defaultWritableRoots: options.defaultWritableRoots ?? [],
        mountRoots: options.mountRoots ?? [],
        trustedRoots: options.trustedRoots ?? [],
      } as CodexAppServerClientBundle;
    },
  });
  t.after(async () => {
    await stage.stop();
    releaseScope();
  });

  await stage.start();

  assert.equal(sessionStarted, true);
  assert.equal(clientOptions.length, 1);
  assert.equal(clientOptions[0]?.rootPlan, stage.rootPlan);
  assert.equal(clientOptions[0]?.providerName, "GuruOpenAI");
  assert.equal(
    clientOptions[0]?.stderrLogPath,
    resolve(fixtureRoot, "run", runId, "logs", "app-server.log"),
  );
  assert.equal(clientOptions[0]?.transportLogPath, undefined);
  assert.deepEqual(clientOptions[0]?.mountRoots, stage.rootPlan.mountRoots);
  assert.deepEqual(clientOptions[0]?.trustedRoots, stage.rootPlan.trustedRoots);
  assert.deepEqual(clientOptions[0]?.defaultWritableRoots, stage.rootPlan.defaultWritableRoots);

  const expectedHome = resolve(fixtureRoot, "run", runId, "codex-home");
  const expectedCodexHome = resolve(expectedHome, ".codex");
  assert.equal(stage.appServerClient.isolatedHome, expectedHome);
  assert.equal(stage.appServerClient.isolatedCodexHome, expectedCodexHome);
  assert.equal(existsSync(expectedCodexHome), true);
  assert.equal(scope.appServer, stage.appServerClient.client);

  const coordinatorMount = resolve(fixtureRoot, "run", runId, "agents", "coordinator", "mount");
  const researcherMount = resolve(fixtureRoot, "run", runId, "agents", "researcher", "mount");
  assert.ok(stage.rootPlan.mountRoots.includes(coordinatorMount));
  assert.ok(stage.rootPlan.trustedRoots.includes(resolve(fixtureRoot)));
  assert.ok(stage.rootPlan.trustedRoots.includes(resolve(homedir(), ".guru", "knowledge")));
  assert.ok(stage.rootPlan.defaultWritableRoots.includes(resolve(homedir(), ".guru", "codebase")));
  const configToml = clientOptions[0]?.configToml ?? "";
  assert.match(configToml, new RegExp(escapeRegExp(`[projects."${coordinatorMount}"]`)));
  assert.match(configToml, new RegExp(escapeRegExp(`[projects."${researcherMount}"]`)));
  assert.match(configToml, new RegExp(escapeRegExp(`[projects."${resolve(fixtureRoot)}"]`)));
  assert.match(configToml, /^model = "gpt-5\.5"$/m);
  assert.match(configToml, /^model_reasoning_effort = "high"$/m);
  assert.match(configToml, /^model_reasoning_summary = "concise"$/m);

  await stage.stop();
  await stage.stop();
  assert.equal(closeCount, 1);
  assert.throws(() => scope.appServer, /app-server is not available/);
});

test("BootClientsStage closes a partially started client when session startup fails", async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-boot-clients-failure-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  let closeCount = 0;
  const scope = new RunScope({
    runId: "boot-clients-failure",
    repoRoot: fixtureRoot,
    logger: noopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: testDomain(),
    terminate: async () => undefined,
  });
  const releaseScope = installRunScope(scope);
  const stage = new BootClientsStage({
    createAppServerClient: (options) => ({
      client: {
        startSession: async () => {
          throw new Error("session failed");
        },
        close: () => {
          closeCount += 1;
        },
      },
      isolatedHome: options.isolatedHome,
      isolatedCodexHome: options.isolatedCodexHome,
      defaultWritableRoots: [],
      mountRoots: [],
      trustedRoots: [],
    } as unknown as CodexAppServerClientBundle),
  });
  t.after(async () => {
    await stage.stop();
    releaseScope();
  });

  await assert.rejects(stage.start(), /session failed/);
  assert.equal(closeCount, 1);
  assert.throws(() => scope.appServer, /app-server is not available/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function noopLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}

function testDomain(): RunScope["domain"] {
  return {
    domainId: "test",
    name: "test",
    dynamicToolsForRole: () => [],
  };
}
