import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssetStore,
  type AgentProfile,
  type WorkflowProfile,
} from "../../src/asset-store/index.js";

const scoutRoot = process.cwd();
type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T[Key] extends object
      ? Mutable<T[Key]>
      : T[Key];
};

test("AssetStore materializes read and write roots from agent profile", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-asset-store-permissions-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(scoutRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  cpSync(join(scoutRoot, "assets", "scout"), join(fixtureRoot, "assets", "scout"), {
    recursive: true,
  });

  const runId = "run-permission-test";
  const mount = new AssetStore().materializeMount({
    scoutRoot: fixtureRoot,
    runId,
    agentId: "verifier",
  });
  const manifest = JSON.parse(readFileSync(mount.manifestPath, "utf8")) as {
    profileReadableRoots: string[];
    profileWritableRoots: string[];
    agentProfile: AgentProfile;
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
  assert.deepEqual(manifest.profileWritableRoots.sort(), [
    "~/.guru/codebase",
    "~/.codegraph",
  ].sort());
  assert.deepEqual(manifest.profileReadableRoots.sort(), [
    "${SCOUT_ROOT}",
    "~/.guru/knowledge",
    "~/.codegraph",
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
    } as NonNullable<WorkflowProfile["roles"][string]["model"]>,
  });

  assert.throws(() => new AssetStore().materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-incomplete-model-override-test",
    agentId: "coordinator",
  }), /roles\.coordinator\.model\.reasoningEffort/);
});

test("AssetStore exposes effective permission roots", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-asset-store-permissions-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(scoutRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  cpSync(join(scoutRoot, "assets", "scout"), join(fixtureRoot, "assets", "scout"), {
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

test("AssetStore accepts an empty Synthesis shell tool set", () => {
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

test("AssetStore mounts shared Worker instructions only for Worker roles", () => {
  const fixtureRoot = createCodexAssetFixture("scout-agent-instructions-");
  const store = new AssetStore();
  for (const agentId of ["coordinator", "researcher", "verifier", "validator"]) {
    const mount = store.materializeMount({
      scoutRoot: fixtureRoot,
      runId: `run-${agentId}-instructions-test`,
      agentId,
    });
    const manifest = JSON.parse(readFileSync(mount.manifestPath, "utf8")) as {
      assets: Array<{ id: string; type: string }>;
      linkedFiles: Array<{ path: string }>;
    };

    assert.equal(existsSync(join(mount.mountRoot, "AGENTS.md")), true);
    const isCoordinator = agentId === "coordinator";
    assert.deepEqual(
      readdirSync(join(mount.mountRoot, "agents")),
      isCoordinator ? [] : ["worker.AGENTS.md"],
    );
    assert.deepEqual(
      manifest.assets
        .filter((asset) => asset.type === "agents_md" || asset.type === "worker_agents_md")
        .map((asset) => asset.id),
      isCoordinator
        ? ["codex.agents.default"]
        : ["codex.agents.default", "codex.agents.worker"],
    );
    assert.deepEqual(
      manifest.linkedFiles
        .filter((file) => file.path.endsWith("AGENTS.md"))
        .map((file) => file.path),
      isCoordinator ? ["AGENTS.md"] : ["AGENTS.md", "agents/worker.AGENTS.md"],
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

test("Only Worker resource hashes depend on shared Worker instructions", () => {
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

test("Resource Park changes affect only roles bound through its Phases", () => {
  const fixtureRoot = createCodexAssetFixture("scout-resource-park-hash-");
  const store = new AssetStore();
  const before = Object.fromEntries(["coordinator", "researcher", "validator"].map((agentId) => [
    agentId,
    store.materializeMount({
      scoutRoot: fixtureRoot,
      runId: `run-${agentId}-park-before-test`,
      agentId,
    }).resourceHash,
  ]));
  const path = join(fixtureRoot, "assets", "codex", "workflows", "validation.json");
  const workflow = JSON.parse(readFileSync(path, "utf8")) as Mutable<WorkflowProfile>;
  workflow.resources["research-artifacts"]!.shellTools.push("head");
  writeFileSync(path, JSON.stringify(workflow, null, 2) + "\n", "utf8");

  const after = Object.fromEntries(["coordinator", "researcher", "validator"].map((agentId) => [
    agentId,
    store.materializeMount({
      scoutRoot: fixtureRoot,
      runId: `run-${agentId}-park-after-test`,
      agentId,
    }).resourceHash,
  ]));

  assert.equal(after.coordinator, before.coordinator);
  assert.notEqual(after.researcher, before.researcher);
  assert.equal(after.validator, before.validator);
});

function createCodexAssetFixture(prefix: string): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(scoutRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  cpSync(join(scoutRoot, "assets", "scout"), join(fixtureRoot, "assets", "scout"), {
    recursive: true,
  });
  return fixtureRoot;
}

function updateAgentProfile(
  fixtureRoot: string,
  agentId: string,
  patch: Partial<AgentProfile>,
): void {
  const path = join(fixtureRoot, "assets", "codex", "workflows", "validation.json");
  const workflow = JSON.parse(readFileSync(path, "utf8")) as Mutable<WorkflowProfile>;
  const role = workflow.roles[agentId];
  if (!role) throw new Error(`Missing Workflow role ${agentId}.`);
  if (patch.multiAgent !== undefined) role.multiAgent = patch.multiAgent;
  if (patch.customAgents !== undefined) role.customAgents = [...patch.customAgents];
  if (patch.model !== undefined) role.model = { ...patch.model };
  if (patch.config !== undefined) workflow.defaults.config = patch.config;
  if (patch.maxThreads !== undefined) workflow.defaults.maxThreads = patch.maxThreads;
  if (patch.maxDepth !== undefined) workflow.defaults.maxDepth = patch.maxDepth;
  const phases = agentId === "coordinator" ? ["Synthesis"] : [...(role.phases ?? [])];
  const resourceEntries = Object.entries(workflow.resources);
  const selectedResourceNames = new Set<string>();
  const defaultResource = resourceEntries.find(([, resource]) => resource.default === true);
  if (!defaultResource) throw new Error("Missing default Resource Park.");
  for (const phase of phases) {
    const matches = resourceEntries.filter(([, resource]) => resource.phases.includes(phase));
    for (const [name] of matches.length > 0 ? matches : [defaultResource]) {
      selectedResourceNames.add(name);
    }
  }
  const resources = resourceEntries
    .filter(([name]) => selectedResourceNames.has(name))
    .map(([, resource]) => resource);
  for (const resource of resources) {
    if (Object.hasOwn(patch, "shellTools")) resource.shellTools = [...(patch.shellTools ?? [])];
    if (patch.mcpServers !== undefined) resource.mcpServers = [...patch.mcpServers];
    if (patch.plugins !== undefined) resource.plugins = [...patch.plugins];
    if (patch.readableRoots !== undefined) resource.readableRoots = [...patch.readableRoots];
    if (patch.writableRoots !== undefined) resource.writableRoots = [...patch.writableRoots];
  }
  writeFileSync(path, JSON.stringify(workflow, null, 2) + "\n", "utf8");
}
