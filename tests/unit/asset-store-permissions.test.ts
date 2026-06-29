import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { AssetStore, type AgentProfilesFile } from "../../src/asset-store/index.js";

const repoRoot = process.cwd();

test("AssetStore materializes per-agent trusted and writable roots from agent profile", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-asset-store-permissions-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });

  const runId = "run-permission-test";
  const mount = new AssetStore().materializeMount({
    repoRoot: fixtureRoot,
    runId,
    agentId: "verifier",
  });
  const manifest = JSON.parse(readFileSync(mount.manifestPath, "utf8")) as {
    trustedRoots: string[];
    writableRoots: string[];
  };
  const expectedMountRoot = join(fixtureRoot, "run", runId, "agents", "verifier", "mount");
  const expectedArtifactRoot = join(fixtureRoot, "run", runId, "agents", "verifier", "artifacts");

  assert.equal(mount.mountRoot, expectedMountRoot);
  assert.deepEqual(mount.trustedRoots.sort(), [
    expectedMountRoot,
    fixtureRoot,
    join(homedir(), ".guru", "knowledge"),
  ].sort());
  assert.deepEqual(mount.writableRoots.sort(), [
    expectedMountRoot,
    expectedArtifactRoot,
    join(homedir(), ".guru", "codebase"),
  ].sort());
  assert.deepEqual(manifest.trustedRoots.sort(), [
    ".",
    relativeFromMount(expectedMountRoot, fixtureRoot),
    relativeFromMount(expectedMountRoot, join(homedir(), ".guru", "knowledge")),
  ].sort());
  assert.deepEqual(manifest.writableRoots.sort(), [
    ".",
    relativeFromMount(expectedMountRoot, expectedArtifactRoot),
    relativeFromMount(expectedMountRoot, join(homedir(), ".guru", "codebase")),
  ].sort());
  assert.equal(mount.mcpServers.some((server) => server.name === "codegraph"), false);
});

test("AssetStore exposes effective permission roots", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-asset-store-permissions-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  const store = new AssetStore();
  const mount = store.materializeMount({
    repoRoot: fixtureRoot,
    runId: "run-effective-permission-test",
    agentId: "researcher",
  });

  assert.ok(store.trustedRootsForMount(mount).includes(fixtureRoot));
  assert.ok(store.trustedRootsForMount(mount).includes(join(homedir(), ".guru", "knowledge")));
  assert.ok(store.trustedRootsForMount(mount).includes(mount.mountRoot));
  assert.ok(store.writableRootsForMount(mount).includes(mount.artifactRoot));
  assert.ok(store.writableRootsForMount(mount).includes(join(homedir(), ".guru", "codebase")));
});

test("AssetStore resolves local profile roots relative to the repo root", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-permissions-");
  updateAgentProfile(fixtureRoot, "coordinator", {
    trustedRoots: ["local/trusted"],
    writableRoots: ["local/writable"],
  });

  const mount = new AssetStore().materializeMount({
    repoRoot: fixtureRoot,
    runId: "run-local-root-test",
    agentId: "coordinator",
  });

  assert.deepEqual(mount.trustedRoots, [join(fixtureRoot, "local", "trusted")]);
  assert.deepEqual(mount.writableRoots, [join(fixtureRoot, "local", "writable")]);
});

test("AssetStore treats omitted profile shellTools as an empty shell tool set", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-permissions-");
  updateAgentProfile(fixtureRoot, "coordinator", {
    shellTools: undefined,
  });

  const mount = new AssetStore().materializeMount({
    repoRoot: fixtureRoot,
    runId: "run-omitted-shell-tools-test",
    agentId: "coordinator",
  });

  assert.deepEqual(mount.shellTools, []);
});

function createCodexAssetFixture(prefix: string): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
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
