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
  realpathSync,
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
import {
  ScoutAgentPermissionProfiles,
  ScoutAgentRoles,
  type ScoutAgentPermissionProfile,
} from "../../src/agent/thread/types.js";
import { AssetStore } from "../../src/asset-store/index.js";

const scoutRoot = process.cwd();

test("RunAppServerStage creates the isolated app-server session and owns its stop", async (t) => {
  installTestCodexHome(t, true, "bearer");
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-boot-clients-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(scoutRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
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
    scoutRoot: fixtureRoot,
    logger: noopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: testDomain(),
    ...createTestRunPersistence(t, runId, fixtureRoot, undefined, join(fixtureRoot, "run", runId)),
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
  const runsRoot = resolve(fixtureRoot, "run");
  const runRoot = resolve(fixtureRoot, "run", runId);
  const coordinatorArtifact = resolve(runRoot, "agents", "coordinator", "artifacts");
  const researcherArtifact = resolve(runRoot, "agents", "researcher", "artifacts");
  const researcherTemp = resolve(runRoot, "agents", "researcher", "tmp");
  const logicalSkillRoot = resolve(fixtureRoot, "assets", "codex", "skills");
  const researcherSkillRoot = join(logicalSkillRoot, "domain-validation-researcher");
  const coordinatorSkillRoot = join(logicalSkillRoot, "domain-validation-coordinator");
  const coordinatorPermissions = stage.rootPlan.permissionProfiles.coordinator;
  const researcherPermissions = stage.rootPlan.permissionProfiles.researcher;
  assert.ok(stage.rootPlan.mountRoots.includes(coordinatorMount));
  assert.ok(stage.rootPlan.writableRoots.includes(resolve(homedir(), ".guru", "codebase")));
  assert.equal(researcherPermissions?.id, ScoutAgentPermissionProfiles.Researcher);
  assert.ok(researcherPermissions?.readableRoots.includes(researcherMount));
  assert.ok(researcherPermissions?.readableRoots.includes(coordinatorArtifact));
  assert.ok(researcherPermissions?.writableRoots.includes(researcherArtifact));
  assert.ok(researcherPermissions?.writableRoots.includes(researcherTemp));
  if (process.platform === "darwin") {
    assert.ok(researcherPermissions?.readableRoots.includes("/System/Library/OpenSSL"));
    assert.ok(researcherPermissions?.writableRoots.includes(resolve(tmpdir())));
    assert.ok(researcherPermissions?.writableRoots.includes(realpathSync(tmpdir())));
  }
  assert.ok(researcherPermissions?.deniedRoots.includes(runsRoot));
  assert.ok(researcherPermissions?.deniedRoots.includes(logicalSkillRoot));
  assert.ok(researcherPermissions?.deniedRoots.includes(realpathSync(logicalSkillRoot)));
  assert.ok(researcherPermissions?.readableRoots.includes(researcherSkillRoot));
  assert.ok(researcherPermissions?.readableRoots.includes(realpathSync(researcherSkillRoot)));
  assert.equal(researcherPermissions?.readableRoots.includes(coordinatorSkillRoot), false);
  assert.ok(coordinatorPermissions?.readableRoots.includes(
    realpathSync(join(fixtureRoot, "assets", "codex", "agents", "AGENTS.md")),
  ));
  assert.ok(coordinatorPermissions?.readableRoots.includes(
    realpathSync(join(fixtureRoot, "assets", "codex", "tools")),
  ));
  assert.ok(coordinatorPermissions?.readableRoots.includes(
    resolve(process.execPath, "..", ".."),
  ));
  const configToml = readFileSync(join(expectedCodexHome, "config.toml"), "utf8");
  assert.match(configToml, new RegExp(escapeRegExp(`[projects."${coordinatorMount}"]`)));
  assert.match(configToml, new RegExp(escapeRegExp(`[projects."${researcherMount}"]`)));
  assert.doesNotMatch(configToml, new RegExp(escapeRegExp(`[projects."${resolve(fixtureRoot)}"]`)));
  assert.match(configToml, /^model = "gpt-5\.5"$/m);
  assert.match(configToml, /^model_provider = "custom"$/m);
  assert.match(configToml, /^\[model_providers\.custom\]$/m);
  assert.match(configToml, /^name = "OpenAI"$/m);
  assert.match(configToml, /^supports_websockets = true$/m);
  assert.doesNotMatch(configToml, /^base_url\s*=/m);
  assert.match(configToml, /^model_reasoning_effort = "high"$/m);
  assert.match(configToml, /^model_reasoning_summary = "concise"$/m);
  assert.match(configToml, /^default_permissions = ":read-only"$/m);
  assert.match(configToml, /^apps = false$/m);
  assert.match(configToml, /^remote_plugin = false$/m);
  assert.match(
    configToml,
    new RegExp(escapeRegExp(`[permissions.${ScoutAgentPermissionProfiles.Researcher}.filesystem]`)),
  );
  assert.match(configToml, new RegExp(escapeRegExp(`"${runsRoot}" = "deny"`)));
  assert.match(configToml, new RegExp(escapeRegExp(`"${researcherMount}" = "read"`)));
  assert.match(configToml, new RegExp(escapeRegExp(`"${coordinatorArtifact}" = "read"`)));
  assert.match(configToml, new RegExp(escapeRegExp(`"${researcherArtifact}" = "write"`)));
  assert.match(configToml, new RegExp(escapeRegExp(`"${researcherTemp}" = "write"`)));
  if (process.platform === "darwin") {
    assert.match(configToml, /^"\/System\/Library\/OpenSSL" = "read"$/m);
    assert.match(
      configToml,
      new RegExp(`^"${escapeRegExp(realpathSync(tmpdir()))}" = "write"$`, "m"),
    );
  }
  assert.match(configToml, new RegExp(escapeRegExp(`"${logicalSkillRoot}" = "deny"`)));
  assert.match(configToml, new RegExp(escapeRegExp(`"${researcherSkillRoot}" = "read"`)));
  assert.doesNotMatch(configToml, /^sandbox_mode\s*=/m);
  assert.match(configToml, /^env_key = "CODEX_API_KEY"$/m);
  assert.doesNotMatch(configToml, /^experimental_bearer_token\s*=/m);
  assert.doesNotMatch(configToml, /source-device-bearer-token/);

  const assetStore = new AssetStore();
  const researcher = assetStore.materializeMount({
    scoutRoot: fixtureRoot,
    runId,
    agentId: ScoutAgentRoles.Researcher,
  });
  const coordinator = assetStore.materializeMount({
    scoutRoot: fixtureRoot,
    runId,
    agentId: ScoutAgentRoles.Coordinator,
  });
  const ownArtifactFile = join(researcher.artifactRoot, "own.txt");
  const sharedArtifactFile = join(coordinator.artifactRoot, "shared.txt");
  const ownLogsFile = join(researcher.logsRoot, "private.log");
  const historicalRunFile = join(runsRoot, "historical-run", "secret.txt");
  writeFileSync(ownArtifactFile, "own artifact\n", "utf8");
  writeFileSync(sharedArtifactFile, "shared artifact\n", "utf8");
  writeFileSync(ownLogsFile, "private log\n", "utf8");
  mkdirSync(join(runsRoot, "historical-run"), { recursive: true });
  writeFileSync(historicalRunFile, "historical run\n", "utf8");
  const exec = async (
    command: string[],
    cwd = researcher.mountRoot,
    permissionProfile: ScoutAgentPermissionProfile = ScoutAgentPermissionProfiles.Researcher,
  ) => stage.appServerClient.client.request(
    "command/exec",
    {
      command,
      cwd,
      permissionProfile,
      timeoutMs: 10_000,
    },
  ) as Promise<{ exitCode: number; stdout: string; stderr: string }>;

  const ownMountRead = await exec(["/bin/cat", join(researcher.mountRoot, "AGENTS.md")]);
  assert.equal(ownMountRead.exitCode, 0, ownMountRead.stderr);
  assert.equal((await exec(["/bin/cat", ownArtifactFile])).stdout, "own artifact\n");
  assert.equal((await exec(["/bin/cat", sharedArtifactFile])).stdout, "shared artifact\n");
  assert.equal(
    (await exec(["/bin/cat", join(coordinator.mountRoot, "AGENTS.md")])).exitCode,
    0,
  );
  assert.notEqual((await exec(["/bin/cat", coordinator.manifestPath])).exitCode, 0);
  assert.notEqual((await exec(["/bin/cat", ownLogsFile])).exitCode, 0);
  assert.notEqual((await exec(["/bin/cat", historicalRunFile])).exitCode, 0);
  const mountedSkillEntry = researcher.skills.find((skill) =>
    skill.name === "domain-validation-researcher"
  );
  assert.ok(mountedSkillEntry);
  const mountedSkill = join(researcher.mountRoot, mountedSkillEntry.path);
  assert.equal((await exec(["/bin/cat", mountedSkill])).exitCode, 0);
  assert.equal(
    (await exec(["/bin/cat", join(researcherSkillRoot, "SKILL.md")])).exitCode,
    0,
  );
  assert.equal((await exec(["/bin/cat", realpathSync(mountedSkill)])).exitCode, 0);
  assert.notEqual(
    (await exec(["/bin/cat", join(coordinatorSkillRoot, "SKILL.md")])).exitCode,
    0,
  );
  assert.notEqual(
    (await exec(["/usr/bin/touch", join(coordinator.artifactRoot, "forbidden.txt")])).exitCode,
    0,
  );
  assert.equal(
    (await exec(["/usr/bin/touch", join(researcher.artifactRoot, "allowed.txt")])).exitCode,
    0,
  );
  assert.notEqual(
    (await exec(["/usr/bin/touch", join(researcher.mountRoot, "forbidden.txt")])).exitCode,
    0,
  );
  const coordinatorOwnAgents = await exec(
    ["/bin/cat", join(coordinator.mountRoot, "agents", "coordinator.AGENTS.md")],
    coordinator.mountRoot,
    ScoutAgentPermissionProfiles.Coordinator,
  );
  assert.equal(coordinatorOwnAgents.exitCode, 0, coordinatorOwnAgents.stderr);
  const coordinatorTool = await exec(
    [join(coordinator.mountRoot, "bin", "scout-assets"), "--smoke"],
    coordinator.mountRoot,
    ScoutAgentPermissionProfiles.Coordinator,
  );
  assert.equal(coordinatorTool.exitCode, 0, coordinatorTool.stderr);
  assert.match(coordinatorTool.stdout, /SCOUT_ASSETS_OK/);

  await stage.stop();
  await stage.stop();
  assert.throws(() => scope.appServer, /app-server is not available/);
});

test("RunAppServerStage preserves its owned client when a second start cannot install it", async (t) => {
  installTestCodexHome(t);
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-boot-clients-failure-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(scoutRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  const runId = "boot-clients-failure";
  const scope = new RunScope({
    runId,
    scoutRoot: fixtureRoot,
    logger: noopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: testDomain(),
    ...createTestRunPersistence(t, runId, fixtureRoot, undefined, join(fixtureRoot, "run", runId)),
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
  cpSync(join(scoutRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  const runId = "boot-clients-provider-missing";
  const scope = new RunScope({
    runId,
    scoutRoot: fixtureRoot,
    logger: noopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: testDomain(),
    ...createTestRunPersistence(t, runId, fixtureRoot, undefined, join(fixtureRoot, "run", runId)),
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
      /Codex model provider "custom" is not configured/,
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
  cpSync(join(scoutRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
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
  const isolatedConfigPath = join(isolatedAuthPath, "..", "config.toml");
  mkdirSync(join(isolatedAuthPath, ".."), { recursive: true });
  writeFileSync(isolatedAuthPath, '{"OPENAI_API_KEY":"source-device-credential"}\n', "utf8");
  writeFileSync(
    isolatedConfigPath,
    [
      'default_permissions = "scout-coordinator"',
      "[permissions.scout-coordinator.filesystem]",
      '"/source-device/repository/run" = "deny"',
      '"/source-device/repository/run/copied/agents/coordinator/mount" = "read"',
      "",
    ].join("\n"),
    "utf8",
  );
  const scope = new RunScope({
    runId,
    scoutRoot: fixtureRoot,
    logger: noopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: testDomain(),
    ...createTestRunPersistence(t, runId, fixtureRoot, undefined, join(fixtureRoot, "run", runId)),
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
  const reboundConfig = readFileSync(isolatedConfigPath, "utf8");
  assert.doesNotMatch(reboundConfig, /source-device/);
  assert.match(
    reboundConfig,
    new RegExp(escapeRegExp(`"${join(fixtureRoot, "run")}" = "deny"`)),
  );
  assert.match(
    reboundConfig,
    new RegExp(escapeRegExp(
      `"${join(fixtureRoot, "run", runId, "agents", "coordinator", "mount")}" = "read"`,
    )),
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
        "[model_providers.custom]",
        'name = "OpenAI"',
        credentialMode === "auth"
          ? "requires_openai_auth = true"
          : credentialMode === "bearer"
          ? 'experimental_bearer_token = "source-device-bearer-token"'
          : 'env_key = "SCOUT_BOOT_CLIENTS_PROVIDER_KEY"',
        "supports_websockets = true",
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
