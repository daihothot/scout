import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  AssetStore,
  type AgentProfilesFile,
  resolveAgentProfile,
} from "../../src/asset-store/index.js";

const scoutRoot = process.cwd();

test("AssetStore materializes read and write roots from agent profile", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-asset-store-permissions-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(scoutRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });

  const runId = "run-permission-test";
  const mount = new AssetStore().materializeMount({
    scoutRoot: fixtureRoot,
    runId,
    agentId: "verifier",
  });
  const manifest = JSON.parse(readFileSync(mount.manifestPath, "utf8")) as {
    readableRoots: string[];
    writableRoots: string[];
    agentProfile: AgentProfilesFile["profiles"][string] & {
      model: NonNullable<AgentProfilesFile["profiles"][string]["model"]>;
    };
  };
  const expectedMountRoot = join(fixtureRoot, "run", runId, "agents", "verifier", "mount");
  const expectedArtifactRoot = join(fixtureRoot, "run", runId, "agents", "verifier", "artifacts");

  assert.equal(mount.mountRoot, expectedMountRoot);
  assert.deepEqual(mount.writableRoots.sort(), [
    join(homedir(), ".guru", "codebase"),
    join(homedir(), ".codegraph"),
  ].sort());
  assert.deepEqual(mount.readableRoots.sort(), [
    fixtureRoot,
    join(homedir(), ".guru", "knowledge"),
    join(homedir(), ".codegraph"),
  ].sort());
  assert.deepEqual(manifest.writableRoots.sort(), [
    relativeFromMount(expectedMountRoot, join(homedir(), ".guru", "codebase")),
    relativeFromMount(expectedMountRoot, join(homedir(), ".codegraph")),
  ].sort());
  assert.deepEqual(manifest.readableRoots.sort(), [
    relativeFromMount(expectedMountRoot, fixtureRoot),
    relativeFromMount(expectedMountRoot, join(homedir(), ".guru", "knowledge")),
    relativeFromMount(expectedMountRoot, join(homedir(), ".codegraph")),
  ].sort());
  assert.equal(mount.mcpServers.some((server) => server.name === "codegraph"), false);
  assert.deepEqual(mount.agentProfile.model, {
    id: "gpt-5.5",
    provider: "custom",
    reasoningEffort: "high",
    reasoningSummary: "concise",
  });
  assert.equal(mount.agentProfile.multiAgent, true);
  assert.equal(mount.agentProfile.maxThreads, 6);
  assert.equal(mount.agentProfile.maxDepth, 1);
  assert.deepEqual(mount.agentProfile.customAgents, ["scout-helper"]);
  assert.deepEqual(mount.customAgents, ["scout-helper"]);
  assert.deepEqual(manifest.agentProfile.model, mount.agentProfile.model);
  assert.equal(manifest.agentProfile.multiAgent, true);
  assert.equal(manifest.agentProfile.maxThreads, 6);
  assert.equal(manifest.agentProfile.maxDepth, 1);
  assert.deepEqual(manifest.agentProfile.customAgents, ["scout-helper"]);
});

test("Agent profiles reject invalid native subagent settings", () => {
  const path = join(scoutRoot, "assets", "codex", "agents", "agent-profiles.json");
  const original = JSON.parse(readFileSync(path, "utf8")) as AgentProfilesFile;
  const cases: Array<{
    key: "multiAgent" | "maxThreads" | "maxDepth" | "customAgents";
    value: unknown;
  }> = [
    { key: "multiAgent", value: "true" },
    { key: "maxThreads", value: 0 },
    { key: "maxDepth", value: -1 },
    { key: "customAgents", value: [""] },
  ];

  for (const invalid of cases) {
    const profiles = structuredClone(original);
    const profile = profiles.profiles.researcher as unknown as Record<string, unknown>;
    profile[invalid.key] = invalid.value;
    assert.throws(
      () => resolveAgentProfile(profiles, "researcher"),
      new RegExp(`agent profile ${invalid.key}`),
    );
  }
});

test("AssetStore rejects a profile that references an unknown custom agent", () => {
  const fixtureRoot = createCodexAssetFixture("scout-custom-agent-unknown-");
  updateAgentProfile(fixtureRoot, "researcher", {
    customAgents: ["missing-helper"],
  });

  assert.throws(() => new AssetStore().materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-custom-agent-unknown-test",
    agentId: "researcher",
  }), /unknown custom agent: missing-helper/);
});

test("AssetStore resolves a complete per-agent model override", () => {
  const fixtureRoot = createCodexAssetFixture("scout-agent-model-profile-");
  updateAgentProfile(fixtureRoot, "coordinator", {
    model: {
      id: "gpt-5.4",
      provider: "GuruOpenAI",
      reasoningEffort: "low",
      reasoningSummary: "detailed",
    },
  });

  const mount = new AssetStore().materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-model-override-test",
    agentId: "coordinator",
  });

  assert.deepEqual(mount.agentProfile.model, {
    id: "gpt-5.4",
    provider: "GuruOpenAI",
    reasoningEffort: "low",
    reasoningSummary: "detailed",
  });
});

test("AssetStore rejects an incomplete per-agent model override", () => {
  const fixtureRoot = createCodexAssetFixture("scout-agent-model-profile-");
  updateAgentProfile(fixtureRoot, "coordinator", {
    model: {
      id: "gpt-5.4",
      provider: "GuruOpenAI",
    } as NonNullable<AgentProfilesFile["profiles"][string]["model"]>,
  });

  assert.throws(() => new AssetStore().materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-incomplete-model-override-test",
    agentId: "coordinator",
  }), /model for agent coordinator\.reasoningEffort/);
});

test("AssetStore exposes effective permission roots", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-asset-store-permissions-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(scoutRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  const store = new AssetStore();
  const mount = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-effective-permission-test",
    agentId: "researcher",
  });

  assert.ok(store.readableRootsForMount(mount).includes(mount.mountRoot));
  assert.ok(store.readableRootsForMount(mount).includes(fixtureRoot));
  assert.ok(store.writableRootsForMount(mount).includes(mount.artifactRoot));
  assert.ok(store.writableRootsForMount(mount).includes(join(homedir(), ".guru", "codebase")));
});

test("AssetStore keeps validator artifact ownership outside profile write roots", () => {
  const fixtureRoot = createCodexAssetFixture("scout-validator-permissions-");
  const runId = "run-validator-permission-test";
  const store = new AssetStore();
  const mount = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId,
    agentId: "validator",
  });

  assert.deepEqual(mount.writableRoots, [
    join(homedir(), ".guru", "codebase"),
    join(homedir(), ".codegraph"),
  ]);
  assert.deepEqual(mount.readableRoots.sort(), [
    join(homedir(), ".guru", "knowledge"),
    join(homedir(), ".guru", "codebase"),
    join(homedir(), ".codegraph"),
  ].sort());
  assert.ok(store.writableRootsForMount(mount).includes(mount.artifactRoot));
});

test("AssetStore resolves local profile roots relative to the Scout root", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-permissions-");
  updateAgentProfile(fixtureRoot, "coordinator", {
    readableRoots: ["local/readable"],
    writableRoots: ["local/writable"],
  });

  const mount = new AssetStore().materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-local-root-test",
    agentId: "coordinator",
  });

  assert.deepEqual(mount.readableRoots, [join(fixtureRoot, "local", "readable")]);
  assert.deepEqual(mount.writableRoots, [join(fixtureRoot, "local", "writable")]);
});

test("AssetStore treats omitted profile shellTools as an empty shell tool set", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-permissions-");
  updateAgentProfile(fixtureRoot, "coordinator", {
    shellTools: undefined,
  });

  const mount = new AssetStore().materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-omitted-shell-tools-test",
    agentId: "coordinator",
  });

  assert.deepEqual(mount.shellTools, []);
});

test("AssetStore only exposes worker instructions to worker mounts", () => {
  const fixtureRoot = createCodexAssetFixture("scout-agent-instructions-");
  const store = new AssetStore();
  const coordinator = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-coordinator-instructions-test",
    agentId: "coordinator",
  });
  const coordinatorManifest = JSON.parse(
    readFileSync(coordinator.manifestPath, "utf8"),
  ) as {
    assets: Array<{ id: string }>;
    linkedFiles: Array<{ path: string }>;
    workerAgent?: string;
  };

  assert.equal(existsSync(join(coordinator.mountRoot, "agents", "worker.AGENTS.md")), false);
  assert.equal(coordinatorManifest.workerAgent, undefined);
  assert.equal(
    coordinatorManifest.assets.some((asset) => asset.id === "codex.agents.worker"),
    false,
  );
  assert.equal(
    coordinatorManifest.linkedFiles.some((file) => file.path === "agents/worker.AGENTS.md"),
    false,
  );

  for (const agentId of ["researcher", "verifier", "validator"]) {
    const worker = store.materializeMount({
      scoutRoot: fixtureRoot,
      runId: `run-${agentId}-instructions-test`,
      agentId,
    });
    const workerManifest = JSON.parse(readFileSync(worker.manifestPath, "utf8")) as {
      assets: Array<{ id: string }>;
      linkedFiles: Array<{ path: string }>;
      workerAgent?: string;
    };

    assert.equal(existsSync(join(worker.mountRoot, "agents", "worker.AGENTS.md")), true);
    assert.equal(workerManifest.workerAgent, "agents/worker.AGENTS.md");
    assert.equal(
      workerManifest.assets.some((asset) => asset.id === "codex.agents.worker"),
      true,
    );
    assert.equal(
      workerManifest.linkedFiles.some((file) => file.path === "agents/worker.AGENTS.md"),
      true,
    );
  }
});

test("AssetStore mounts scout-helper only for Worker profiles", () => {
  const fixtureRoot = createCodexAssetFixture("scout-custom-agent-mount-");
  const store = new AssetStore();
  const coordinator = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-coordinator-custom-agent-test",
    agentId: "coordinator",
  });
  const coordinatorManifest = JSON.parse(readFileSync(coordinator.manifestPath, "utf8")) as {
    assets: Array<{ id: string }>;
    linkedFiles: Array<{ path: string }>;
    customAgents: string[];
  };

  assert.deepEqual(coordinator.customAgents, []);
  assert.deepEqual(coordinatorManifest.customAgents, []);
  assert.equal(existsSync(join(coordinator.mountRoot, ".codex", "agents", "scout-helper.toml")), false);
  assert.equal(
    coordinatorManifest.assets.some((asset) => asset.id === "codex.custom_agent.scout-helper"),
    false,
  );
  assert.equal(
    coordinatorManifest.linkedFiles.some((file) => file.path === ".codex/agents/scout-helper.toml"),
    false,
  );

  for (const agentId of ["researcher", "verifier", "validator"]) {
    const worker = store.materializeMount({
      scoutRoot: fixtureRoot,
      runId: `run-${agentId}-custom-agent-test`,
      agentId,
    });
    const helperPath = join(worker.mountRoot, ".codex", "agents", "scout-helper.toml");
    const workerManifest = JSON.parse(readFileSync(worker.manifestPath, "utf8")) as {
      assets: Array<{ id: string }>;
      linkedFiles: Array<{ path: string }>;
      customAgents: string[];
    };

    assert.deepEqual(worker.customAgents, ["scout-helper"]);
    assert.deepEqual(workerManifest.customAgents, ["scout-helper"]);
    assert.equal(existsSync(helperPath), true);
    const helperConfig = readFileSync(helperPath, "utf8");
    assert.match(helperConfig, /不得调用任何 Scout dynamic tool/);
    assert.match(helperConfig, /^model = "gpt-5\.5"$/m);
    assert.match(helperConfig, /^model_reasoning_effort = "high"$/m);
    assert.equal(
      workerManifest.assets.some((asset) => asset.id === "codex.custom_agent.scout-helper"),
      true,
    );
    assert.equal(
      workerManifest.linkedFiles.some((file) => file.path === ".codex/agents/scout-helper.toml"),
      true,
    );
  }
});

test("Coordinator resource hash does not depend on worker instructions", () => {
  const fixtureRoot = createCodexAssetFixture("scout-agent-instructions-hash-");
  const store = new AssetStore();
  const coordinatorBefore = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-coordinator-hash-before-test",
    agentId: "coordinator",
  });
  const researcherBefore = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-researcher-hash-before-test",
    agentId: "researcher",
  });

  writeFileSync(
    join(fixtureRoot, "assets", "codex", "agents", "worker.AGENTS.md"),
    "updated worker instructions\n",
    "utf8",
  );

  const coordinatorAfter = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-coordinator-hash-after-test",
    agentId: "coordinator",
  });
  const researcherAfter = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-researcher-hash-after-test",
    agentId: "researcher",
  });

  assert.equal(coordinatorAfter.resourceHash, coordinatorBefore.resourceHash);
  assert.notEqual(researcherAfter.resourceHash, researcherBefore.resourceHash);
});

test("Coordinator resource hash does not depend on an unmounted custom agent", () => {
  const fixtureRoot = createCodexAssetFixture("scout-custom-agent-hash-");
  const store = new AssetStore();
  const coordinatorBefore = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-coordinator-custom-agent-hash-before-test",
    agentId: "coordinator",
  });
  const researcherBefore = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-researcher-custom-agent-hash-before-test",
    agentId: "researcher",
  });

  writeFileSync(
    join(fixtureRoot, "assets", "codex", "agents", "scout-helper.toml"),
    "name = \"scout-helper\"\ndescription = \"updated\"\ndeveloper_instructions = \"updated\"\n",
    "utf8",
  );

  const coordinatorAfter = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-coordinator-custom-agent-hash-after-test",
    agentId: "coordinator",
  });
  const researcherAfter = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-researcher-custom-agent-hash-after-test",
    agentId: "researcher",
  });

  assert.equal(coordinatorAfter.resourceHash, coordinatorBefore.resourceHash);
  assert.notEqual(researcherAfter.resourceHash, researcherBefore.resourceHash);
});

function createCodexAssetFixture(prefix: string): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(scoutRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  return fixtureRoot;
}

function updateAgentProfile(
  fixtureRoot: string,
  agentId: string,
  patch: Partial<AgentProfilesFile["profiles"][string]>,
): void {
  const path = join(fixtureRoot, "assets", "codex", "agents", "agent-profiles.json");
  const profiles = JSON.parse(readFileSync(path, "utf8")) as AgentProfilesFile;
  const profile = profiles.profiles[agentId];
  profiles.profiles[agentId] = {
    ...profile,
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
  };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) continue;
    const mutableProfile: Record<string, unknown> = profiles.profiles[agentId] as unknown as Record<string, unknown>;
    delete mutableProfile[key];
  }
  writeFileSync(path, JSON.stringify(profiles, null, 2) + "\n", "utf8");
}

function relativeFromMount(mountRoot: string, target: string): string {
  const relative = relativePath(mountRoot, target);
  return relative || ".";
}

function relativePath(from: string, to: string): string {
  return relative(from, to);
}
