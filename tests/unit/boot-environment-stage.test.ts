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
import {
  AssetStore,
  type MaterializeOptions,
  type MountManifest,
} from "../../src/asset-store/index.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { Scheduler } from "../../src/core/workflow/index.js";
import type { Logger } from "../../src/core/logging/index.js";
import {
  NoopRuntimeInteractionPort,
  type SubprocessProgressSnapshot,
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
import type { ScoutConfig } from "../../src/system/config/index.js";
import type { RunJournal } from "../../src/run/journal/index.js";
import { RunManifestStore } from "../../src/run/persistence/index.js";
import {
  createTestScheduler,
  createTestRunPersistence,
  installTestRunScope,
} from "../helpers/run-persistence.js";

const scoutRoot = process.cwd();

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

  const roles = createTestScheduler().snapshot().roles.map((role) => role.name);
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
  assert.ok(stage.rootAccess.writableRoots.includes(resolve(homedir(), ".guru", "codebase")));
  assert.equal(runtime.scope.environment.agents, stage.agents);
  assert.equal(runtime.scope.environment.rootAccess, stage.rootAccess);
  assert.equal(
    runtime.scope.contextBundle.assetCommit.assetCommitId,
    stage.agents.coordinator.assetCommit.assetCommitId,
  );
  const manifest = runtime.scope.manifestStore.read();
  const runRoot = join(fixtureRoot, "run", stage.runId);
  assert.equal(manifest.version, 1);
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

test("PrepareEnvironmentStage overlaps independent role preflights", async (t) => {
  const fixtureRoot = createFixture("scout-boot-environment-parallel-");
  const runtime = installEnvironmentScope(t, fixtureRoot, "boot-environment-parallel");
  t.after(runtime.release);
  let activePreflights = 0;
  let maxActivePreflights = 0;
  const stage = new PrepareEnvironmentStage({
    preflightMount: async () => {
      activePreflights += 1;
      maxActivePreflights = Math.max(maxActivePreflights, activePreflights);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activePreflights -= 1;
      return { status: "passed" };
    },
  });

  await stage.start();

  assert.ok(maxActivePreflights > 1);
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
  assert.ok(snapshots.some((snapshot) => snapshot.phase === "running"));
  assert.ok(snapshots.some((snapshot) => snapshot.descriptor.progress?.detail === "layout"));
  assert.ok(snapshots.some((snapshot) => snapshot.descriptor.progress?.detail === "plugins"));
  assert.ok(snapshots.some((snapshot) => snapshot.descriptor.progress?.detail === "shell"));
  assert.ok(snapshots.some((snapshot) => snapshot.descriptor.progress?.detail === "preflight"));
  const rebuildingSnapshots = snapshots.filter((snapshot) =>
    snapshot.phase === "running" && snapshot.descriptor.progress,
  );
  assert.ok(rebuildingSnapshots.every((snapshot) =>
    snapshot.totalUnits === createTestScheduler().snapshot().roles.map((role) => role.name).length * 6
  ));
  const final = snapshots.at(-1);
  assert.ok(final);
  assert.equal(final.phase, "done");
  assert.equal(final.totalUnits, createTestScheduler().snapshot().roles.map((role) => role.name).length * 6);
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
      return mount.agentId === "coordinator"
        ? { status: "failed" }
        : { status: "passed" };
    },
  });

  await assert.rejects(stage.start(), /preflight failed/);

  const roles = createTestScheduler().snapshot().roles.map((role) => role.name);
  assert.deepEqual(preflightedAgents.sort(), [...roles].sort());
  assert.equal(stage.prepared, true);
  assert.ok(Object.values(stage.agents).every((agent) =>
    existsSync(agent.preflightPath) && existsSync(agent.assetCommitPath)
  ));
  assert.equal(stage.agents["coordinator"].assetCommit.status, "preflight_failed");
  assert.ok(Object.values(stage.agents)
    .filter((agent) => agent.role !== "coordinator")
    .every((agent) => agent.assetCommit.status === "preflight_passed"));
  assert.equal(runtime.scope.hasEnvironment, true);
  const failed = interactionPort.progress.filter((snapshot) => snapshot.phase === "failed").at(-1);
  assert.ok(failed);
  assert.equal(
    failed.descriptor.status.detail,
    `${"coordinator"} preflight`,
  );
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

  const coordinator = runtime.scope.environment.agents["coordinator"];
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

test("RestoreEnvironmentStage applies the explicit global resource-drift policy", async (t) => {
  const fixtureRoot = createFixture("scout-restore-environment-drift-allowed-");
  const initial = installEnvironmentScope(t, fixtureRoot, "restore-environment-drift-allowed");
  let initialReleased = false;
  t.after(() => {
    if (!initialReleased) initial.release();
  });
  await new PrepareEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();

  const coordinator = initial.scope.environment.agents["coordinator"];
  const previousResourceHash = coordinator.mount.resourceHash;
  const mountManifest = JSON.parse(
    readFileSync(coordinator.mount.manifestPath, "utf8"),
  ) as MountManifest;
  const sourceAsset = mountManifest.assets.find((asset) => asset.type !== "plugin");
  assert.ok(sourceAsset);
  writeFileSync(resolve(fixtureRoot, sourceAsset.sourcePath), "changed", "utf8");

  const journal = initial.scope.journal;
  const manifestStore = initial.scope.manifestStore;
  initial.release();
  initialReleased = true;
  const resumed = installExistingEnvironmentScope(
    fixtureRoot,
    "restore-environment-drift-allowed",
    journal,
    manifestStore,
    new NoopRuntimeInteractionPort(),
    {
      workflow: { profile: "validation" },
      restore: { allowAssetResourceDrift: true },
    },
  );
  let resumedReleased = false;
  t.after(() => {
    if (!resumedReleased) resumed.release();
  });

  await new RestoreEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();

  const current = resumed.scope.environment.agents["coordinator"];
  assert.notEqual(current.mount.resourceHash, previousResourceHash);
  assert.equal(
    JSON.parse(readFileSync(current.mount.manifestPath, "utf8")).resourceHash,
    current.mount.resourceHash,
  );
  const restoredEntry = resumed.scope.manifestStore.read().agents?.[
    "coordinator"
  ];
  assert.ok(restoredEntry);
  assert.equal(restoredEntry.mountId, current.mount.mountId);
  assert.equal(restoredEntry.assetCommitId, current.assetCommit.assetCommitId);
  assert.equal(restoredEntry.resourceHash, current.assetCommit.resourceHash);
  resumed.release();
  resumedReleased = true;

  const second = installExistingEnvironmentScope(
    fixtureRoot,
    "restore-environment-drift-allowed",
    journal,
    manifestStore,
    new NoopRuntimeInteractionPort(),
    {
      workflow: { profile: "validation" },
      restore: { allowAssetResourceDrift: true },
    },
  );
  let secondReleased = false;
  t.after(() => {
    if (!secondReleased) second.release();
  });
  await new RestoreEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();
  assert.equal(
    second.scope.environment.agents["coordinator"].mount.mountId,
    current.mount.mountId,
  );
  second.release();
  secondReleased = true;
});

test("RestoreEnvironmentStage rolls back the run index when metadata commit fails", async (t) => {
  const fixtureRoot = createFixture("scout-restore-environment-metadata-rollback-");
  const runId = "restore-environment-metadata-rollback";
  const initial = installEnvironmentScope(t, fixtureRoot, runId);
  let initialReleased = false;
  t.after(() => {
    if (!initialReleased) initial.release();
  });
  await new PrepareEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();

  const coordinator = initial.scope.environment.agents["coordinator"];
  const previousManifest = readFileSync(coordinator.mount.manifestPath, "utf8");
  const previousAssetCommit = readFileSync(coordinator.assetCommitPath, "utf8");
  const previousPreflight = readFileSync(coordinator.preflightPath, "utf8");
  const previousRunManifest = initial.scope.manifestStore.read();
  const sourceAsset = (JSON.parse(previousManifest) as MountManifest).assets
    .find((asset) => asset.type !== "plugin");
  assert.ok(sourceAsset);
  writeFileSync(resolve(fixtureRoot, sourceAsset.sourcePath), "changed", "utf8");

  const journal = initial.scope.journal;
  initial.release();
  initialReleased = true;
  const failingManifestStore = new FailOnceManifestUpdateStore(
    join(fixtureRoot, "run", runId),
  );
  const failed = installExistingEnvironmentScope(
    fixtureRoot,
    runId,
    journal,
    failingManifestStore,
    new NoopRuntimeInteractionPort(),
    {
      workflow: { profile: "validation" },
      restore: { allowAssetResourceDrift: true },
    },
  );
  let failedReleased = false;
  t.after(() => {
    if (!failedReleased) failed.release();
  });

  await assert.rejects(
    new RestoreEnvironmentStage({
      preflightMount: async () => ({ status: "passed" }),
    }).start(),
    /Injected run manifest update failure/,
  );

  assert.equal(readFileSync(coordinator.mount.manifestPath, "utf8"), previousManifest);
  assert.equal(readFileSync(coordinator.assetCommitPath, "utf8"), previousAssetCommit);
  assert.equal(readFileSync(coordinator.preflightPath, "utf8"), previousPreflight);
  assert.deepEqual(failingManifestStore.read(), previousRunManifest);
  failed.release();
  failedReleased = true;
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
      mkdirSync(codexRoot, { recursive: true });
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
    "validator",
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
      "validator"
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
    "validator",
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
    scoutRoot: fixtureRoot,
    appServer: {} as CodexAppServerClient,
    journal: initial.scope.journal,
    manifestStore: initial.scope.manifestStore,
  });
  await new RestoreEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();

  assert.equal(lstatSync(join(fixtureRoot, "assets")).isSymbolicLink(), true);
  assert.equal(realpathSync(join(fixtureRoot, "assets")), realpathSync(join(scoutRoot, "assets")));
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

  const roles = createTestScheduler().snapshot().roles.map((role) => role.name);
  const sentinels = new Map<string, string>();
  const mountTimes = new Map<string, number>();
  for (const role of roles) {
    const mountRoot = initial.scope.environment.agents[role].mount.mountRoot;
    const sentinel = join(mountRoot, "reuse-sentinel.txt");
    writeFileSync(sentinel, role, "utf8");
    sentinels.set(role, sentinel);
    mountTimes.set(role, statSync(mountRoot).mtimeMs);
  }
  const damagedRole = "validator";
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
  assert.equal(firstFinal.descriptor.status.detail, "Mount · ready · 3/4 reusable");
  assert.ok(firstProgressPort.progress.some((snapshot) =>
    snapshot.phase === "running"
    && snapshot.descriptor.progress
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
  assert.ok(secondProgressPort.progress.every((snapshot) => !snapshot.descriptor.progress));
  assert.equal(secondFinal.descriptor.status.detail, "Mount · ready · 4/4 reusable");
  secondResume.release();
  secondReleased = true;
});

test("RestoreEnvironmentStage follows current GraphState roles and retains removed role history", async (t) => {
  const fixtureRoot = createFixture("scout-restore-dynamic-roles-");
  const runId = "restore-dynamic-roles";
  const initial = installEnvironmentScope(t, fixtureRoot, runId);
  let initialReleased = false;
  t.after(() => {
    if (!initialReleased) initial.release();
  });
  await new PrepareEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();
  const removedMountRoot = initial.scope.environment.agents.verifier.mount.mountRoot;
  const journal = initial.scope.journal;
  const manifestStore = initial.scope.manifestStore;
  initial.release();
  initialReleased = true;

  const workflowPath = join(
    fixtureRoot,
    "assets",
    "codex",
    "workflows",
    "validation.json",
  );
  const workflow = JSON.parse(readFileSync(workflowPath, "utf8")) as {
    roles: Record<string, {
      phases?: string[];
      multiAgent: boolean;
      customAgents: string[];
    }>;
  };
  delete workflow.roles.verifier;
  workflow.roles.auditor = {
    phases: ["verify"],
    multiAgent: true,
    customAgents: ["scout-helper"],
  };
  writeFileSync(workflowPath, JSON.stringify(workflow, null, 2) + "\n", "utf8");

  const scheduler = new Scheduler(
    new AssetStore().buildWorkflow(fixtureRoot, "validation"),
    new InMemoryEventBus(),
  );
  const resumed = installExistingEnvironmentScope(
    fixtureRoot,
    runId,
    journal,
    manifestStore,
    new NoopRuntimeInteractionPort(),
    {
      workflow: { profile: "validation" },
      restore: { allowAssetResourceDrift: true },
    },
    scheduler,
  );
  let resumedReleased = false;
  t.after(() => {
    if (!resumedReleased) resumed.release();
  });

  await new RestoreEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();

  assert.deepEqual(Object.keys(resumed.scope.environment.agents), [
    "coordinator",
    "researcher",
    "validator",
    "auditor",
  ]);
  assert.equal(existsSync(removedMountRoot), true);
  assert.ok(existsSync(resumed.scope.environment.agents.auditor.mount.manifestPath));
  const manifest = manifestStore.read();
  assert.ok(manifest.agents?.verifier);
  assert.ok(manifest.agents?.auditor);
  resumed.release();
  resumedReleased = true;
});

test("RestoreEnvironmentStage self-heals a partial mount without rebuilding completed roles", async (t) => {
  const fixtureRoot = createLinkedAssetsFixture(t, "scout-restore-partial-mount-");
  const runId = "restore-partial-mount";
  const initial = installEnvironmentScope(t, fixtureRoot, runId);
  let initialReleased = false;
  t.after(() => {
    if (!initialReleased) initial.release();
  });
  await new PrepareEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();

  const coordinatorRoot = initial.scope.environment.agents.coordinator.mount.mountRoot;
  const researcherRoot = initial.scope.environment.agents.researcher.mount.mountRoot;
  for (const mountRoot of [coordinatorRoot, researcherRoot]) {
    const configPath = join(mountRoot, ".codex", "config.toml");
    writeFileSync(configPath, readFileSync(configPath, "utf8") + "# force rebuild\n", "utf8");
  }
  const journal = initial.scope.journal;
  const manifestStore = initial.scope.manifestStore;
  initial.release();
  initialReleased = true;

  const failedProgress = new CapturingMountProgressPort();
  const failedResume = installExistingEnvironmentScope(
    fixtureRoot,
    runId,
    journal,
    manifestStore,
    failedProgress,
  );
  let failedReleased = false;
  t.after(() => {
    if (!failedReleased) failedResume.release();
  });
  await assert.rejects(
    new RestoreEnvironmentStage({
      assetStore: new FailOnceAfterConfigAssetStore("coordinator"),
      preflightMount: async () => ({ status: "passed" }),
    }).start(),
    /Injected materialization failure after config for coordinator/,
  );
  const failedSnapshot = failedProgress.progress
    .filter((snapshot) => snapshot.phase === "failed")
    .at(-1);
  assert.ok(failedSnapshot);
  assert.equal(failedSnapshot.descriptor.status.detail, "coordinator config");
  assert.equal(
    existsSync(join(coordinatorRoot, ".agents", "plugins", "marketplace.json")),
    false,
    "the injected failure should leave coordinator incomplete",
  );
  assert.equal(
    existsSync(join(researcherRoot, ".agents", "plugins", "marketplace.json")),
    true,
    "the parallel researcher rebuild should complete",
  );
  const researcherSentinel = join(researcherRoot, "completed-before-retry.txt");
  writeFileSync(researcherSentinel, "preserve\n", "utf8");
  failedResume.release();
  failedReleased = true;

  const retryProgress = new CapturingMountProgressPort();
  const retry = installExistingEnvironmentScope(
    fixtureRoot,
    runId,
    journal,
    manifestStore,
    retryProgress,
  );
  let retryReleased = false;
  t.after(() => {
    if (!retryReleased) retry.release();
  });
  await new RestoreEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();
  const retryFinal = retryProgress.progress.at(-1);
  assert.ok(retryFinal);
  assert.equal(retryFinal.phase, "done");
  assert.equal(retryFinal.totalUnits, 9);
  assert.equal(retryFinal.descriptor.status.detail, "Mount · ready · 3/4 reusable");
  assert.equal(readFileSync(researcherSentinel, "utf8"), "preserve\n");
  const coordinatorSentinel = join(coordinatorRoot, "completed-after-retry.txt");
  writeFileSync(coordinatorSentinel, "preserve\n", "utf8");
  retry.release();
  retryReleased = true;

  const finalProgress = new CapturingMountProgressPort();
  const finalResume = installExistingEnvironmentScope(
    fixtureRoot,
    runId,
    journal,
    manifestStore,
    finalProgress,
  );
  let finalReleased = false;
  t.after(() => {
    if (!finalReleased) finalResume.release();
  });
  await new RestoreEnvironmentStage({
    preflightMount: async () => ({ status: "passed" }),
  }).start();
  const final = finalProgress.progress.at(-1);
  assert.ok(final);
  assert.equal(final.totalUnits, createTestScheduler().snapshot().roles.map((role) => role.name).length);
  assert.equal(final.descriptor.status.detail, "Mount · ready · 4/4 reusable");
  assert.ok(finalProgress.progress.every((snapshot) => !snapshot.descriptor.progress));
  assert.equal(readFileSync(coordinatorSentinel, "utf8"), "preserve\n");
  assert.equal(readFileSync(researcherSentinel, "utf8"), "preserve\n");
  finalResume.release();
  finalReleased = true;
});

function createFixture(prefix: string): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(scoutRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  return fixtureRoot;
}

function createLinkedAssetsFixture(
  t: import("node:test").TestContext,
  prefix: string,
): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  symlinkSync(join(scoutRoot, "assets"), join(fixtureRoot, "assets"), "dir");
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
    runtime.scope.environment.agents["coordinator"].mount.mountRoot,
    "containment-sentinel.txt",
  );
  writeFileSync(coordinatorSentinel, "preserve until validation finishes\n", "utf8");
  return { fixtureRoot, runtime, coordinatorSentinel };
}

function installEnvironmentScope(
  t: import("node:test").TestContext,
  scoutRoot: string,
  runId: string,
  interactionPort: RuntimeInteractionPort = new NoopRuntimeInteractionPort(),
  scoutConfig?: ScoutConfig,
): {
  scope: RunScope;
  appServer: CodexAppServerClient;
  release(): void;
} {
  const appServer = {} as CodexAppServerClient;
  const scope = new RunScope({
    runId,
    scoutRoot,
    logger: noopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort,
    scoutConfig,
    domain: {
      domainId: "test",
      name: "test",
      dynamicToolsForRole: () => [],
    },
    ...createTestRunPersistence(
      t,
      runId,
      scoutRoot,
      undefined,
      join(scoutRoot, "run", runId),
    ),
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
  scoutRoot: string,
  runId: string,
  journal: RunJournal,
  manifestStore: RunManifestStore,
  interactionPort: RuntimeInteractionPort,
  scoutConfig?: ScoutConfig,
  scheduler: Scheduler = createTestScheduler(),
): {
  scope: RunScope;
  appServer: CodexAppServerClient;
  release(): void;
} {
  const appServer = {} as CodexAppServerClient;
  const scope = new RunScope({
    runId,
    scoutRoot,
    runRoot: join(scoutRoot, "run", runId),
    logger: noopLogger(),
    eventBus: new InMemoryEventBus(),
    scheduler,
    interactionPort,
    scoutConfig,
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
  readonly progress: SubprocessProgressSnapshot[] = [];

  override async publishSubprocessProgress(progress: SubprocessProgressSnapshot): Promise<void> {
    this.progress.push(structuredClone(progress));
  }
}

class FailOnceAfterConfigAssetStore extends AssetStore {
  private failed = false;

  constructor(private readonly targetRole: string) {
    super();
  }

  override prepareMount(
    options: MaterializeOptions,
    observeMaterializationStep?: MaterializeOptions["onMaterializationStep"],
  ) {
    if (options.agentId !== this.targetRole || this.failed) {
      return super.prepareMount(options, observeMaterializationStep);
    }
    return super.prepareMount(options, (step) => {
      observeMaterializationStep?.(step);
      if (step === "config") {
        this.failed = true;
        throw new Error(`Injected materialization failure after config for ${this.targetRole}`);
      }
    });
  }
}

class FailOnceManifestUpdateStore extends RunManifestStore {
  private failed = false;

  override update(update: Parameters<RunManifestStore["update"]>[0]) {
    if (!this.failed) {
      this.failed = true;
      throw new Error("Injected run manifest update failure");
    }
    return super.update(update);
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
