import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";
import type { MountManifest } from "../../src/asset-store/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import type { Logger } from "../../src/core/logging/index.js";
import {
  NoopRuntimeInteractionPort,
  type MountRestoreProgress,
  type RuntimeInteractionPort,
} from "../../src/interaction/protocol/port.js";
import { PrepareEnvironmentStage } from "../../src/run/startup/index.js";
import {
  ResumeClientsStage,
  RestoreEnvironmentStage,
} from "../../src/run/resume/stages/index.js";
import {
  installRunScope,
  RunScope,
} from "../../src/run/run-scope.js";
import type { RunJournal } from "../../src/run/journal/index.js";
import type { RunManifestStore } from "../../src/run/persistence/index.js";
import {
  createTestRunPersistence,
  installTestRunScope,
} from "../helpers/run-persistence.js";

const repoRoot = process.cwd();

test("PrepareEnvironmentStage materializes, preflights, and commits every agent mount", async (t) => {
  const fixtureRoot = createFixture("scout-boot-environment-");
  const runtime = installEnvironmentScope(t, fixtureRoot, "boot-environment-test");
  t.after(runtime.release);
  const preflightedAgents: string[] = [];
  const stage = new PrepareEnvironmentStage({
    preflightMount: async (mount) => {
      preflightedAgents.push(mount.agentId);
      return { status: "passed" };
    },
  });

  await stage.start();

  const roles = Object.values(ScoutAgentRoles);
  assert.deepEqual(preflightedAgents.sort(), [...roles].sort());
  assert.deepEqual(Object.keys(stage.agents).sort(), [...roles].sort());
  for (const role of roles) {
    const agent = stage.agents[role];
    assert.equal(
      agent.mount.mountRoot,
      join(fixtureRoot, "run", stage.runId, "agents", role, "mount"),
    );
    assert.ok(existsSync(agent.preflightPath));
    assert.ok(existsSync(agent.assetCommitPath));
    assert.equal(agent.assetCommit.status, "preflight_passed");
    assert.equal(agent.assetCommit.preflightRef, agent.preflightPath);
    assert.equal(JSON.parse(readFileSync(agent.preflightPath, "utf8")).status, "passed");
  }
  assert.ok(stage.rootAccess.trustedRoots.includes(resolve(fixtureRoot)));
  assert.ok(stage.rootAccess.trustedRoots.includes(resolve(homedir(), ".guru", "knowledge")));
  assert.ok(stage.rootAccess.writableRoots.includes(resolve(homedir(), ".guru", "codebase")));
  assert.equal(runtime.scope.environment.agents, stage.agents);
  assert.equal(runtime.scope.environment.rootAccess, stage.rootAccess);
  assert.equal(
    runtime.scope.contextBundle.assetCommit.assetCommitId,
    stage.agents.coordinator.assetCommit.assetCommitId,
  );
  const manifest = runtime.scope.manifestStore.read();
  const runRoot = join(fixtureRoot, "run", stage.runId);
  assert.equal(manifest.version, 2);
  assert.equal("environment" in manifest, false);
  assert.equal("assetCommitId" in manifest, false);
  assert.deepEqual(Object.keys(manifest.agents ?? {}).sort(), [...roles].sort());
  for (const role of roles) {
    const agent = stage.agents[role];
    const entry = manifest.agents?.[role];
    assert.ok(entry);
    assert.equal(entry.mountId, agent.mount.mountId);
    assert.equal(entry.assetCommitId, agent.assetCommit.assetCommitId);
    assert.equal(entry.resourceHash, agent.assetCommit.resourceHash);
    assert.equal(entry.mountManifestRef, relative(runRoot, agent.mount.manifestPath));
    assert.equal(entry.assetCommitRef, relative(runRoot, agent.assetCommitPath));
    assert.equal(entry.preflightRef, relative(runRoot, agent.preflightPath));
  }
});

test("PrepareEnvironmentStage reports six rebuild units per role", async (t) => {
  const fixtureRoot = createFixture("scout-boot-environment-progress-");
  const interactionPort = new CapturingMountProgressPort();
  const runtime = installEnvironmentScope(t, fixtureRoot, "boot-environment-progress", interactionPort);
  t.after(runtime.release);
  const stage = new PrepareEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  });

  await stage.start();

  const snapshots = interactionPort.progress;
  assert.ok(snapshots.some((snapshot) => snapshot.phase === "rebuild"));
  assert.ok(snapshots.some((snapshot) => snapshot.activeStep === "layout"));
  assert.ok(snapshots.some((snapshot) => snapshot.activeStep === "plugins"));
  assert.ok(snapshots.some((snapshot) => snapshot.activeStep === "shell"));
  assert.ok(snapshots.some((snapshot) => snapshot.activeStep === "preflight"));
  const rebuildingSnapshots = snapshots.filter((snapshot) => snapshot.phase === "rebuild");
  assert.ok(rebuildingSnapshots.every((snapshot) =>
    snapshot.totalUnits === Object.values(ScoutAgentRoles).length * 6
  ));
  const final = snapshots.at(-1);
  assert.ok(final);
  assert.equal(final.phase, "done");
  assert.equal(final.totalUnits, Object.values(ScoutAgentRoles).length * 6);
  assert.equal(final.completedUnits, final.totalUnits);
  for (let index = 1; index < snapshots.length; index += 1) {
    assert.ok(snapshots[index]!.completedUnits >= snapshots[index - 1]!.completedUnits);
  }
});

test("PrepareEnvironmentStage collects every role before reporting a failed preflight", async (t) => {
  const fixtureRoot = createFixture("scout-boot-environment-failed-");
  const interactionPort = new CapturingMountProgressPort();
  const runtime = installEnvironmentScope(
    t,
    fixtureRoot,
    "boot-environment-failed",
    interactionPort,
  );
  t.after(runtime.release);
  const preflightedAgents: string[] = [];
  const stage = new PrepareEnvironmentStage({
    preflightMount: async (mount) => {
      preflightedAgents.push(mount.agentId);
      return mount.agentId === ScoutAgentRoles.Coordinator
        ? { status: "failed" }
        : { status: "passed" };
    },
  });

  await assert.rejects(stage.start(), /preflight failed/);

  const roles = Object.values(ScoutAgentRoles);
  assert.deepEqual(preflightedAgents.sort(), [...roles].sort());
  assert.equal(stage.prepared, true);
  assert.ok(Object.values(stage.agents).every((agent) =>
    existsSync(agent.preflightPath) && existsSync(agent.assetCommitPath)
  ));
  assert.equal(stage.agents[ScoutAgentRoles.Coordinator].assetCommit.status, "preflight_failed");
  assert.ok(Object.values(stage.agents)
    .filter((agent) => agent.role !== ScoutAgentRoles.Coordinator)
    .every((agent) => agent.assetCommit.status === "preflight_passed"));
  assert.equal(runtime.scope.hasEnvironment, true);
  const failed = interactionPort.progress.filter((snapshot) => snapshot.phase === "failed").at(-1);
  assert.ok(failed);
  assert.equal(failed.activeRole, ScoutAgentRoles.Coordinator);
  assert.equal(failed.activeStep, "preflight");
  for (const role of roles) {
    assert.ok(existsSync(join(
      fixtureRoot,
      "run",
      "boot-environment-failed",
      "agents",
      role,
      "artifacts",
      "asset-commit.json",
    )));
  }
});

test("RestoreEnvironmentStage rejects source asset drift", async (t) => {
  const fixtureRoot = createFixture("scout-restore-environment-drift-");
  const runtime = installEnvironmentScope(t, fixtureRoot, "restore-environment-drift");
  t.after(runtime.release);
  const startStage = new PrepareEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  });
  await startStage.start();

  const coordinator = runtime.scope.environment.agents[ScoutAgentRoles.Coordinator];
  const mountManifest = JSON.parse(
    readFileSync(coordinator.mount.manifestPath, "utf8"),
  ) as MountManifest;
  const sourceAsset = mountManifest.assets.find((asset) => asset.type !== "plugin");
  assert.ok(sourceAsset);
  writeFileSync(resolve(fixtureRoot, sourceAsset.sourcePath), "changed", "utf8");

  await assert.rejects(
    new RestoreEnvironmentStage().start(),
    /Persisted asset changed/,
  );
});

for (const scenario of [
  {
    name: "codex-home",
    arrange(runRoot: string, fixtureRoot: string): string {
      const outsideCodexHome = join(fixtureRoot, "outside-codex-home");
      const configPath = join(outsideCodexHome, ".codex", "config.toml");
      mkdirSync(join(outsideCodexHome, ".codex", "sessions"), { recursive: true });
      writeFileSync(configPath, "sentinel\n", "utf8");
      mkdirSync(runRoot, { recursive: true });
      symlinkSync(outsideCodexHome, join(runRoot, "codex-home"), "dir");
      return configPath;
    },
  },
  {
    name: ".codex",
    arrange(runRoot: string, fixtureRoot: string): string {
      const codexHome = join(runRoot, "codex-home");
      const outsideCodexRoot = join(fixtureRoot, "outside-dot-codex");
      const configPath = join(outsideCodexRoot, "config.toml");
      mkdirSync(join(outsideCodexRoot, "sessions"), { recursive: true });
      writeFileSync(configPath, "sentinel\n", "utf8");
      mkdirSync(codexHome, { recursive: true });
      symlinkSync(outsideCodexRoot, join(codexHome, ".codex"), "dir");
      return configPath;
    },
  },
  {
    name: "sessions",
    arrange(runRoot: string, fixtureRoot: string): string {
      const codexRoot = join(runRoot, "codex-home", ".codex");
      const outsideSessions = join(fixtureRoot, "outside-sessions");
      const configPath = join(codexRoot, "config.toml");
      mkdirSync(codexRoot, { recursive: true });
      mkdirSync(outsideSessions, { recursive: true });
      writeFileSync(configPath, "sentinel\n", "utf8");
      symlinkSync(outsideSessions, join(codexRoot, "sessions"), "dir");
      return configPath;
    },
  },
  {
    name: "config.toml",
    arrange(runRoot: string, fixtureRoot: string): string {
      const codexRoot = join(runRoot, "codex-home", ".codex");
      const outsideConfig = join(fixtureRoot, "outside-config.toml");
      mkdirSync(join(codexRoot, "sessions"), { recursive: true });
      writeFileSync(outsideConfig, "sentinel\n", "utf8");
      symlinkSync(outsideConfig, join(codexRoot, "config.toml"));
      return outsideConfig;
    },
  },
]) {
  test(`ResumeClientsStage rejects a symlinked ${scenario.name} before Codex writes`, async (t) => {
    const fixtureRoot = createLinkedAssetsFixture(t, `scout-resume-${scenario.name}-`);
    const runId = `resume-${scenario.name}`;
    const runtime = installEnvironmentScope(t, fixtureRoot, runId);
    t.after(runtime.release);
    const configPath = scenario.arrange(join(fixtureRoot, "run", runId), fixtureRoot);

    await assert.rejects(
      new ResumeClientsStage().start(),
      /Refusing symlinked Codex home component/,
    );

    assert.equal(readFileSync(configPath, "utf8"), "sentinel\n");
  });
}

test("RestoreEnvironmentStage rejects a symlinked Agent root before rebuilding any mount", async (t) => {
  const prepared = await prepareLinkedEnvironment(t, "agent-root-symlink");
  const validatorRoot = join(
    prepared.fixtureRoot,
    "run",
    prepared.runtime.scope.runId,
    "agents",
    ScoutAgentRoles.Validator,
  );
  const outsideValidatorRoot = join(prepared.fixtureRoot, "outside-validator");
  renameSync(validatorRoot, outsideValidatorRoot);
  symlinkSync(outsideValidatorRoot, validatorRoot, "dir");

  await assert.rejects(
    new RestoreEnvironmentStage({
      preflightMount: async () => ({ status: "passed" }),
    }).start(),
    /Refusing symlinked persisted validator agent root component/,
  );

  assert.ok(existsSync(prepared.coordinatorSentinel));
});

test("PrepareEnvironmentStage rejects a symlinked run ancestor before materializing", async (t) => {
  const fixtureRoot = createLinkedAssetsFixture(t, "scout-boot-run-ancestor-symlink-");
  const runId = "boot-run-ancestor-symlink";
  const runtime = installEnvironmentScope(t, fixtureRoot, runId);
  t.after(runtime.release);
  const runRoot = join(fixtureRoot, "run", runId);
  const outsideAgents = join(fixtureRoot, "outside-agents");
  mkdirSync(outsideAgents, { recursive: true });
  mkdirSync(runRoot, { recursive: true });
  symlinkSync(outsideAgents, join(runRoot, "agents"), "dir");

  await assert.rejects(
    new PrepareEnvironmentStage({
      preflightMount: async () => ({ status: "passed" }),
    }).start(),
    /Refusing symlinked startup run component/,
  );
  assert.deepEqual(readdirSync(outsideAgents), []);
});

for (const ref of [
  ["mountManifestRef", "mount manifest"],
  ["assetCommitRef", "asset commit"],
  ["preflightRef", "preflight report"],
] as const) {
  test(`RestoreEnvironmentStage rejects a symlinked ${ref[1]} before rebuilding any mount`, async (t) => {
    const prepared = await prepareLinkedEnvironment(t, `${ref[0]}-symlink`);
    const runRoot = join(
      prepared.fixtureRoot,
      "run",
      prepared.runtime.scope.runId,
    );
    const entry = prepared.runtime.scope.manifestStore.read().agents?.[
      ScoutAgentRoles.Validator
    ];
    assert.ok(entry);
    const refPath = resolve(runRoot, entry[ref[0]]);
    const outsideRef = join(prepared.fixtureRoot, `outside-${ref[0]}.json`);
    renameSync(refPath, outsideRef);
    symlinkSync(outsideRef, refPath);

    await assert.rejects(
      new RestoreEnvironmentStage({
        preflightMount: async () => ({ status: "passed" }),
      }).start(),
      new RegExp(`Refusing symlinked persisted validator ${ref[1]} component`),
    );

    assert.ok(existsSync(prepared.coordinatorSentinel));
  });
}

test("RestoreEnvironmentStage rejects an intermediate symlink before rebuilding any mount", async (t) => {
  const prepared = await prepareLinkedEnvironment(t, "intermediate-symlink");
  const validatorArtifacts = join(
    prepared.fixtureRoot,
    "run",
    prepared.runtime.scope.runId,
    "agents",
    ScoutAgentRoles.Validator,
    "artifacts",
  );
  const outsideArtifacts = join(prepared.fixtureRoot, "outside-validator-artifacts");
  renameSync(validatorArtifacts, outsideArtifacts);
  symlinkSync(outsideArtifacts, validatorArtifacts, "dir");

  await assert.rejects(
    new RestoreEnvironmentStage({
      preflightMount: async () => ({ status: "passed" }),
    }).start(),
    /Refusing symlinked persisted validator asset commit component/,
  );

  assert.ok(existsSync(prepared.coordinatorSentinel));
});

test("RestoreEnvironmentStage permits the ScoutRoot assets symlink", async (t) => {
  const fixtureRoot = createLinkedAssetsFixture(t, "scout-restore-assets-link-");
  const runId = "restore-assets-link";
  const initial = installEnvironmentScope(t, fixtureRoot, runId);
  let initialReleased = false;
  t.after(() => {
    if (!initialReleased) initial.release();
  });
  await new PrepareEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();
  initial.release();
  initialReleased = true;

  const resumed = installTestRunScope(t, {
    runId,
    repoRoot: fixtureRoot,
    appServer: {} as CodexAppServerClient,
    journal: initial.scope.journal,
    manifestStore: initial.scope.manifestStore,
  });
  await new RestoreEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();

  assert.equal(lstatSync(join(fixtureRoot, "assets")).isSymbolicLink(), true);
  assert.equal(realpathSync(join(fixtureRoot, "assets")), realpathSync(join(repoRoot, "assets")));
  assert.equal(resumed.hasEnvironment, true);
});

test("RestoreEnvironmentStage rebuilds only damaged roles and is idempotent", async (t) => {
  const fixtureRoot = createLinkedAssetsFixture(t, "scout-restore-mixed-");
  const runId = "restore-mixed";
  const initial = installEnvironmentScope(t, fixtureRoot, runId);
  let initialReleased = false;
  t.after(() => {
    if (!initialReleased) initial.release();
  });
  await new PrepareEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();

  const roles = Object.values(ScoutAgentRoles);
  const sentinels = new Map<string, string>();
  const mountTimes = new Map<string, number>();
  for (const role of roles) {
    const mountRoot = initial.scope.environment.agents[role].mount.mountRoot;
    const sentinel = join(mountRoot, "reuse-sentinel.txt");
    writeFileSync(sentinel, role, "utf8");
    sentinels.set(role, sentinel);
    mountTimes.set(role, statSync(mountRoot).mtimeMs);
  }
  const damagedRole = ScoutAgentRoles.Validator;
  const damagedConfig = join(
    initial.scope.environment.agents[damagedRole].mount.mountRoot,
    ".codex",
    "config.toml",
  );
  writeFileSync(damagedConfig, `${readFileSync(damagedConfig, "utf8")}# damaged\n`, "utf8");

  const journal = initial.scope.journal;
  const manifestStore = initial.scope.manifestStore;
  initial.release();
  initialReleased = true;

  const firstProgressPort = new CapturingMountProgressPort();
  const firstResume = installExistingEnvironmentScope(
    fixtureRoot,
    runId,
    journal,
    manifestStore,
    firstProgressPort,
  );
  let firstReleased = false;
  t.after(() => {
    if (!firstReleased) firstResume.release();
  });
  await new RestoreEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();

  const firstFinal = firstProgressPort.progress.at(-1);
  assert.ok(firstFinal);
  assert.equal(firstFinal.phase, "done");
  assert.equal(firstFinal.totalUnits, 9);
  assert.equal(firstFinal.completedUnits, 9);
  assert.deepEqual(
    firstFinal.roles.map((role) => [role.role, role.decision]),
    roles.map((role) => [role, role === damagedRole ? "rebuild" : "reused"]),
  );
  assert.ok(firstProgressPort.progress.some((snapshot) =>
    snapshot.phase === "rebuild"
    && snapshot.totalUnits === 9
    && snapshot.completedUnits === 3
  ));
  for (const role of roles.filter((role) => role !== damagedRole)) {
    assert.equal(readFileSync(sentinels.get(role)!, "utf8"), role);
    assert.equal(statSync(firstResume.scope.environment.agents[role].mount.mountRoot).mtimeMs, mountTimes.get(role));
  }
  assert.equal(existsSync(sentinels.get(damagedRole)!), false);
  firstResume.release();
  firstReleased = true;

  const secondProgressPort = new CapturingMountProgressPort();
  const secondResume = installExistingEnvironmentScope(
    fixtureRoot,
    runId,
    journal,
    manifestStore,
    secondProgressPort,
  );
  let secondReleased = false;
  t.after(() => {
    if (!secondReleased) secondResume.release();
  });
  await new RestoreEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();
  const secondFinal = secondProgressPort.progress.at(-1);
  assert.ok(secondFinal);
  assert.equal(secondFinal.phase, "done");
  assert.equal(secondFinal.totalUnits, roles.length);
  assert.equal(secondFinal.completedUnits, roles.length);
  assert.ok(secondProgressPort.progress.every((snapshot) => snapshot.phase !== "rebuild"));
  assert.ok(secondFinal.roles.every((role) => role.decision === "reused"));
  secondResume.release();
  secondReleased = true;
});

test("RestoreEnvironmentStage upgrades an old resource inventory once and then rejects script drift", async (t) => {
  const fixtureRoot = createFixture("scout-restore-legacy-resource-inventory-");
  const runId = "restore-legacy-resource-inventory";
  const initial = installEnvironmentScope(t, fixtureRoot, runId);
  let initialReleased = false;
  t.after(() => {
    if (!initialReleased) initial.release();
  });
  await new PrepareEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();

  const legacyResourceHashes: Partial<Record<string, string>> = {};
  const preservedIdentities: Partial<Record<string, {
    assetCommitId: string;
    parentAssetCommitId?: string;
    mountId: string;
  }>> = {};
  for (const role of Object.values(ScoutAgentRoles)) {
    const agent = initial.scope.environment.agents[role];
    const legacyResourceHash = `unreconstructable-legacy-resource-hash-${role}`;
    const mountManifest = JSON.parse(
      readFileSync(agent.mount.manifestPath, "utf8"),
    ) as MountManifest;
    delete mountManifest.resourceInventoryVersion;
    mountManifest.resourceHash = legacyResourceHash;
    mountManifest.assets = mountManifest.assets.filter((asset) =>
      asset.type !== "shell_tool_resource"
      && asset.type !== "mcp_server_resource"
      && asset.type !== "mcp_server_vendor"
    );
    writeFileSync(
      agent.mount.manifestPath,
      `${JSON.stringify(mountManifest, null, 2)}\n`,
      "utf8",
    );

    const assetCommit = JSON.parse(readFileSync(agent.assetCommitPath, "utf8")) as {
      resourceHash: string;
    };
    assetCommit.resourceHash = legacyResourceHash;
    writeFileSync(
      agent.assetCommitPath,
      `${JSON.stringify(assetCommit, null, 2)}\n`,
      "utf8",
    );
    legacyResourceHashes[role] = legacyResourceHash;
    preservedIdentities[role] = {
      assetCommitId: agent.assetCommit.assetCommitId,
      parentAssetCommitId: agent.assetCommit.parentAssetCommitId,
      mountId: agent.assetCommit.mountId,
    };
  }
  initial.scope.manifestStore.update((manifest) => {
    assert.ok(manifest.agents);
    const agents = structuredClone(manifest.agents);
    for (const role of Object.values(ScoutAgentRoles)) {
      agents[role].resourceHash = legacyResourceHashes[role]!;
    }
    return { ...manifest, agents };
  });
  initial.release();
  initialReleased = true;

  const resumed = installTestRunScope(t, {
    runId,
    repoRoot: fixtureRoot,
    appServer: {} as CodexAppServerClient,
    journal: initial.scope.journal,
    manifestStore: initial.scope.manifestStore,
  });

  await assert.rejects(
    new RestoreEnvironmentStage({
      preflightMount: async (mount) => ({
        status: mount.agentId === ScoutAgentRoles.Validator ? "failed" : "passed",
      }),
    }).start(),
    /Scout run restore preflight failed/,
  );
  const failedIndex = resumed.manifestStore.read().agents;
  assert.ok(failedIndex);
  for (const role of Object.values(ScoutAgentRoles)) {
    const manifestPath = join(
      fixtureRoot,
      "run",
      runId,
      "agents",
      role,
      "mount",
      "mount-manifest.json",
    );
    const mountManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as MountManifest;
    assert.equal(failedIndex[role].resourceHash, legacyResourceHashes[role]);
    assert.equal(mountManifest.resourceHash, legacyResourceHashes[role]);
    assert.equal(mountManifest.resourceInventoryVersion, undefined);
  }

  const updateManifest = resumed.manifestStore.update.bind(resumed.manifestStore);
  let rejectManifestUpdate = true;
  resumed.manifestStore.update = (update) => {
    if (rejectManifestUpdate) {
      rejectManifestUpdate = false;
      throw new Error("injected legacy resource index update failure");
    }
    return updateManifest(update);
  };
  try {
    await assert.rejects(
      new RestoreEnvironmentStage({
        preflightMount: async () => ({ status: "passed" }),
      }).start(),
      /injected legacy resource index update failure/,
    );
  } finally {
    resumed.manifestStore.update = updateManifest;
  }
  const rejectedIndex = resumed.manifestStore.read().agents;
  assert.ok(rejectedIndex);
  for (const role of Object.values(ScoutAgentRoles)) {
    const manifestPath = join(
      fixtureRoot,
      "run",
      runId,
      "agents",
      role,
      "mount",
      "mount-manifest.json",
    );
    const commitPath = join(
      fixtureRoot,
      "run",
      runId,
      "agents",
      role,
      "artifacts",
      "asset-commit.json",
    );
    const mountManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as MountManifest;
    const assetCommit = JSON.parse(readFileSync(commitPath, "utf8")) as {
      resourceHash: string;
    };
    assert.equal(rejectedIndex[role].resourceHash, legacyResourceHashes[role]);
    assert.equal(mountManifest.resourceHash, legacyResourceHashes[role]);
    assert.equal(assetCommit.resourceHash, legacyResourceHashes[role]);
  }

  await new RestoreEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();

  const migratedIndex = resumed.manifestStore.read().agents;
  assert.ok(migratedIndex);
  for (const role of Object.values(ScoutAgentRoles)) {
    const agent = resumed.environment.agents[role];
    const mountManifest = JSON.parse(
      readFileSync(agent.mount.manifestPath, "utf8"),
    ) as MountManifest;
    assert.equal(agent.assetCommit.assetCommitId, preservedIdentities[role]!.assetCommitId);
    assert.equal(
      agent.assetCommit.parentAssetCommitId,
      preservedIdentities[role]!.parentAssetCommitId,
    );
    assert.equal(agent.assetCommit.mountId, preservedIdentities[role]!.mountId);
    assert.notEqual(agent.assetCommit.resourceHash, legacyResourceHashes[role]);
    assert.equal(migratedIndex[role].resourceHash, agent.assetCommit.resourceHash);
    assert.equal(mountManifest.resourceInventoryVersion, 1);
    assert.ok(mountManifest.assets.some((asset) => asset.type === "shell_tool_resource"));
  }

  const scriptPath = join(fixtureRoot, "assets", "codex", "tools", "scout-memory.cjs");
  writeFileSync(scriptPath, `${readFileSync(scriptPath, "utf8")}\nscript drift\n`, "utf8");
  await assert.rejects(
    new RestoreEnvironmentStage({
      preflightMount: async () => ({ status: "passed" }),
    }).start(),
    /Persisted asset changed/,
  );
});

function createFixture(prefix: string): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  return fixtureRoot;
}

function createLinkedAssetsFixture(
  t: import("node:test").TestContext,
  prefix: string,
): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  symlinkSync(join(repoRoot, "assets"), join(fixtureRoot, "assets"), "dir");
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  return fixtureRoot;
}

async function prepareLinkedEnvironment(
  t: import("node:test").TestContext,
  suffix: string,
): Promise<{
  fixtureRoot: string;
  runtime: ReturnType<typeof installEnvironmentScope>;
  coordinatorSentinel: string;
}> {
  const fixtureRoot = createLinkedAssetsFixture(t, `scout-restore-${suffix}-`);
  const runtime = installEnvironmentScope(t, fixtureRoot, `restore-${suffix}`);
  t.after(runtime.release);
  await new PrepareEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();
  const coordinatorSentinel = join(
    runtime.scope.environment.agents[ScoutAgentRoles.Coordinator].mount.mountRoot,
    "containment-sentinel.txt",
  );
  writeFileSync(coordinatorSentinel, "preserve until validation finishes\n", "utf8");
  return { fixtureRoot, runtime, coordinatorSentinel };
}

function installEnvironmentScope(
  t: import("node:test").TestContext,
  repoRoot: string,
  runId: string,
  interactionPort: RuntimeInteractionPort = new NoopRuntimeInteractionPort(),
): {
  scope: RunScope;
  appServer: CodexAppServerClient;
  release(): void;
} {
  const appServer = {} as CodexAppServerClient;
  const scope = new RunScope({
    runId,
    repoRoot,
    logger: noopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort,
    domain: {
      domainId: "test",
      name: "test",
      dynamicToolsForRole: () => [],
    },
    ...createTestRunPersistence(t, runId, repoRoot),
    terminate: async () => undefined,
  });
  scope.setAppServer(appServer);
  const releaseScope = installRunScope(scope);
  return {
    scope,
    appServer,
    release() {
      scope.clearAppServer(appServer);
      releaseScope();
    },
  };
}

function installExistingEnvironmentScope(
  repoRoot: string,
  runId: string,
  journal: RunJournal,
  manifestStore: RunManifestStore,
  interactionPort: RuntimeInteractionPort,
): {
  scope: RunScope;
  appServer: CodexAppServerClient;
  release(): void;
} {
  const appServer = {} as CodexAppServerClient;
  const scope = new RunScope({
    runId,
    repoRoot,
    logger: noopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort,
    domain: {
      domainId: "test",
      name: "test",
      dynamicToolsForRole: () => [],
    },
    journal,
    manifestStore,
    terminate: async () => undefined,
  });
  scope.setAppServer(appServer);
  const releaseScope = installRunScope(scope);
  return {
    scope,
    appServer,
    release() {
      scope.clearAppServer(appServer);
      releaseScope();
    },
  };
}

class CapturingMountProgressPort extends NoopRuntimeInteractionPort {
  readonly progress: MountRestoreProgress[] = [];

  override async publishMountRestoreProgress(progress: MountRestoreProgress): Promise<void> {
    this.progress.push(structuredClone(progress));
  }
}

function noopLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}
