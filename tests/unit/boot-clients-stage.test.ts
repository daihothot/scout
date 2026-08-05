import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
  installTestCodexHome(t, true, "bearer");
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-boot-clients-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  const staleAuthPath = join(
    fixtureRoot,
    "run",
    "boot-clients-test",
    "codex-home",
    ".codex",
    "auth.json",
  );
  mkdirSync(join(staleAuthPath, ".."), { recursive: true });
  writeFileSync(staleAuthPath, '{"OPENAI_API_KEY":"source-device-credential"}\n', "utf8");

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
  assert.equal(existsSync(staleAuthPath), false);
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
  assert.match(configToml, /^env_key = "CODEX_API_KEY"$/m);
  assert.doesNotMatch(configToml, /^experimental_bearer_token\s*=/m);
  assert.doesNotMatch(configToml, /source-device-bearer-token/);

  await stage.stop();
  await stage.stop();
  assert.throws(() => scope.appServer, /app-server is not available/);
});

test("RunAppServerStage preserves its owned client when a second start cannot install it", async (t) => {
  installTestCodexHome(t);
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

test("RunAppServerStage rejects a missing target model provider without falling back", async (t) => {
  installTestCodexHome(t, false);
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-boot-clients-provider-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  const runId = "boot-clients-provider-missing";
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

  await assert.rejects(stage.start(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(
      error.message,
      /Codex model provider "GuruOpenAI" is not configured/,
    );
    assert.doesNotMatch(error.message, /scout-test-provider-token/);
    return true;
  });
  assert.throws(() => scope.appServer, /app-server is not available/);
});

test("RunAppServerStage rebinds target Codex auth without retaining copied credentials", async (t) => {
  const targetAuthPath = installTestCodexHome(t, true, "auth");
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-boot-clients-auth-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  const runId = "boot-clients-auth-rebind";
  const isolatedAuthPath = join(
    fixtureRoot,
    "run",
    runId,
    "codex-home",
    ".codex",
    "auth.json",
  );
  mkdirSync(join(isolatedAuthPath, ".."), { recursive: true });
  writeFileSync(isolatedAuthPath, '{"OPENAI_API_KEY":"source-device-credential"}\n', "utf8");
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

  assert.equal(lstatSync(isolatedAuthPath).isSymbolicLink(), true);
  assert.equal(readlinkSync(isolatedAuthPath), targetAuthPath);
  assert.equal(
    JSON.parse(readFileSync(isolatedAuthPath, "utf8")).OPENAI_API_KEY,
    "target-device-credential",
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function installTestCodexHome(
  t: TestContext,
  includeProvider = true,
  credentialMode: "env" | "auth" | "bearer" = "env",
): string {
  const testHome = mkdtempSync(join(tmpdir(), "scout-boot-clients-home-"));
  const testCodexHome = join(testHome, ".codex");
  mkdirSync(testCodexHome, { recursive: true });
  writeFileSync(
    join(testCodexHome, "config.toml"),
    includeProvider
      ? [
        "[model_providers.GuruOpenAI]",
        'name = "GuruOpenAI"',
        'base_url = "https://example.invalid/v1"',
        credentialMode === "auth"
          ? "requires_openai_auth = true"
          : credentialMode === "bearer"
          ? 'experimental_bearer_token = "source-device-bearer-token"'
          : 'env_key = "SCOUT_BOOT_CLIENTS_PROVIDER_KEY"',
        'wire_api = "responses"',
        "",
      ].join("\n")
      : [
        "[model_providers.OtherProvider]",
        'name = "OtherProvider"',
        'base_url = "https://example.invalid/v1"',
        'env_key = "SCOUT_BOOT_CLIENTS_PROVIDER_KEY"',
        "",
      ].join("\n"),
    "utf8",
  );
  const targetAuthPath = join(testCodexHome, "auth.json");
  if (credentialMode === "auth") {
    writeFileSync(
      targetAuthPath,
      '{"OPENAI_API_KEY":"target-device-credential"}\n',
      "utf8",
    );
  }
  const previousHome = process.env.HOME;
  const previousProviderKey = process.env.SCOUT_BOOT_CLIENTS_PROVIDER_KEY;
  process.env.HOME = testHome;
  process.env.SCOUT_BOOT_CLIENTS_PROVIDER_KEY = "scout-test-provider-token";
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProviderKey === undefined) delete process.env.SCOUT_BOOT_CLIENTS_PROVIDER_KEY;
    else process.env.SCOUT_BOOT_CLIENTS_PROVIDER_KEY = previousProviderKey;
  });
  return targetAuthPath;
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
