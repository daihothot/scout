import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RunAppServerStage } from "../../src/run/lifecycle/index.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import type { Logger } from "../../src/core/logging/index.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/protocol/port.js";
import {
  installRunScope,
  RunScope,
} from "../../src/run/run-scope.js";
import { createTestRunPersistence } from "../helpers/run-persistence.js";

const repoRoot = process.cwd();

test("RunAppServerStage creates the isolated app-server session and owns its stop", async (t) => {
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
    ...createTestRunPersistence(t, runId, fixtureRoot),
    terminate: async () => undefined,
  });
  const releaseScope = installRunScope(scope);
  const stage = new RunAppServerStage();
  t.after(async () => {
    await stage.stop();
    releaseScope();
  });

  await stage.start();

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
  const configToml = readFileSync(join(expectedCodexHome, "config.toml"), "utf8");
  assert.match(configToml, new RegExp(escapeRegExp(`[projects."${coordinatorMount}"]`)));
  assert.match(configToml, new RegExp(escapeRegExp(`[projects."${researcherMount}"]`)));
  assert.match(configToml, new RegExp(escapeRegExp(`[projects."${resolve(fixtureRoot)}"]`)));
  assert.match(configToml, /^model = "gpt-5\.5"$/m);
  assert.match(configToml, /^model_reasoning_effort = "high"$/m);
  assert.match(configToml, /^model_reasoning_summary = "concise"$/m);

  await stage.stop();
  await stage.stop();
  assert.throws(() => scope.appServer, /app-server is not available/);
});

test("RunAppServerStage preserves its owned client when a second start cannot install it", async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-boot-clients-failure-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  const runId = "boot-clients-failure";
  const scope = new RunScope({
    runId,
    repoRoot: fixtureRoot,
    logger: noopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: testDomain(),
    ...createTestRunPersistence(t, runId, fixtureRoot),
    terminate: async () => undefined,
  });
  const releaseScope = installRunScope(scope);
  const stage = new RunAppServerStage();
  t.after(async () => {
    await stage.stop();
    releaseScope();
  });

  await stage.start();
  const ownedClient = stage.appServerClient.client;

  await assert.rejects(stage.start(), /Run app-server is already available/);
  assert.equal(scope.appServer, ownedClient);

  await stage.stop();
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
