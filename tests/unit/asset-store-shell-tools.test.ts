import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssetStore,
  type AgentProfilesFile,
  type McpServersFile,
  type MountManifest,
  type ShellToolsFile,
} from "../../src/asset-store/index.js";

const repoRoot = process.cwd();

test("AssetStore reports unresolved shell tools as issues and excludes them from mount outputs", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-shell-tools-");
  const assetsRoot = join(fixtureRoot, "assets", "codex");
  writeShellTools(assetsRoot, {
    tools: [
      {
        id: "requiredMissing",
        name: "required-missing",
        command: "/definitely/missing/scout-required-tool",
        exposeAs: "required-missing",
        required: true,
      },
      {
        id: "optionalMissing",
        name: "optional-missing",
        command: "/definitely/missing/scout-optional-tool",
        exposeAs: "optional-missing",
        required: false,
      },
    ],
  });
  updateCoordinatorShellTools(assetsRoot, [
    "requiredMissing",
    "optionalMissing",
  ]);

  const mount = new AssetStore().materializeMount({
    repoRoot: fixtureRoot,
    runId: "run-shell-tool-materialization-test",
    agentId: "coordinator",
  });
  const manifest = JSON.parse(readFileSync(mount.manifestPath, "utf8")) as MountManifest;

  assert.deepEqual(mount.shellTools, []);
  assert.deepEqual(manifest.shellTools, []);
  assert.equal(existsSync(join(mount.mountRoot, "bin", "required-missing")), false);
  assert.equal(existsSync(join(mount.mountRoot, "bin", "optional-missing")), false);
  assert.equal(manifest.generatedFiles.some((file) => file.path === "bin/required-missing"), false);
  assert.equal(manifest.generatedFiles.some((file) => file.path === "bin/optional-missing"), false);
  assert.deepEqual(mount.issues.map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    resourceId: issue.resourceId,
  })), [
    {
      severity: "error",
      code: "shell_tool_unresolved",
      resourceId: "requiredMissing",
    },
    {
      severity: "warning",
      code: "shell_tool_unresolved",
      resourceId: "optionalMissing",
    },
  ]);
  assert.deepEqual(manifest.issues, mount.issues);
});

test("AssetStore exposes scout-memory for all agent mounts", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-shell-tools-");
  const store = new AssetStore();

  for (const agentId of ["coordinator", "researcher", "verifier", "validator"]) {
    const mount = store.materializeMount({
      repoRoot: fixtureRoot,
      runId: `run-shell-tool-${agentId}-test`,
      agentId,
    });
    const manifest = JSON.parse(readFileSync(mount.manifestPath, "utf8")) as MountManifest;

    assert.ok(mount.shellTools.some((tool) => tool.id === "scoutMemory"));
    assert.ok(manifest.shellTools.some((tool) => tool.exposeAs === "scout-memory"));
    assert.equal(existsSync(join(mount.mountRoot, "bin", "scout-memory")), true);
  }
});

test("AssetStore exposes mounted Skill readers to the coordinator", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-coordinator-readers-");
  const mount = new AssetStore().materializeMount({
    repoRoot: fixtureRoot,
    runId: "run-shell-tool-coordinator-readers-test",
    agentId: "coordinator",
  });
  const manifest = JSON.parse(readFileSync(mount.manifestPath, "utf8")) as MountManifest;

  for (const tool of ["cat", "sed"]) {
    assert.ok(mount.shellTools.some((candidate) => candidate.id === tool));
    assert.ok(manifest.shellTools.some((candidate) => candidate.exposeAs === tool));
    assert.equal(existsSync(join(mount.mountRoot, "bin", tool)), true);
  }
});

test("AssetStore statically binds the Validation Domain skill for every role", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-validation-skills-");
  const expectedSkills = {
    coordinator: "coordinator-validation",
    researcher: "researcher-validation",
    verifier: "verifier-validation",
    validator: "validator-validation",
  } as const;
  const store = new AssetStore();

  for (const [agentId, skill] of Object.entries(expectedSkills)) {
    const mount = store.materializeMount({
      repoRoot: fixtureRoot,
      runId: `run-validation-skill-${agentId}-test`,
      agentId,
    });
    const manifest = JSON.parse(readFileSync(mount.manifestPath, "utf8")) as MountManifest;

    assert.ok(mount.skills.includes(skill));
    assert.ok(manifest.skills.includes(skill));
    assert.equal(existsSync(join(
      mount.mountRoot,
      ".agents",
      "skills",
      skill,
      "SKILL.md",
    )), true);
  }
});

test("AssetStore exposes Research artifact checking and git tools to the researcher", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-research-tools-");
  const mount = new AssetStore().materializeMount({
    repoRoot: fixtureRoot,
    runId: "run-shell-tool-researcher-validation-test",
    agentId: "researcher",
  });
  const checker = mount.shellTools.find((tool) => tool.id === "scoutResearchArtifactCheck");
  const git = mount.shellTools.find((tool) => tool.id === "git");
  const wrapperPath = join(mount.mountRoot, "bin", "scout-research-artifact-check");

  assert.ok(checker);
  assert.ok(git);
  assert.equal(existsSync(wrapperPath), true);
  assert.match(execFileSync(wrapperPath, ["--smoke"], {
    cwd: mount.mountRoot,
    encoding: "utf8",
  }), /SCOUT_RESEARCH_ARTIFACT_CHECK_OK/);
});

test("AssetStore gives the validator producer contracts, code inspection tools, and a neutral digest tool", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-validator-tools-");
  const mount = new AssetStore().materializeMount({
    repoRoot: fixtureRoot,
    runId: "run-shell-tool-validator-gate-test",
    agentId: "validator",
  });
  const digest = mount.shellTools.find((tool) => tool.id === "scoutArtifactDigest");
  const wrapperPath = join(mount.mountRoot, "bin", "scout-artifact-digest");

  assert.ok(mount.skills.includes("validator-validation"));
  assert.ok(mount.skills.includes("guru-knowledge-research"));
  assert.ok(mount.skills.includes("jarvis-codebase"));
  assert.equal(mount.shellTools.some((tool) => tool.id === "scoutResearchArtifactCheck"), false);
  assert.ok(mount.shellTools.some((tool) => tool.id === "jarvis"));
  assert.ok(mount.shellTools.some((tool) => tool.id === "codegraph"));
  assert.ok(mount.shellTools.some((tool) => tool.id === "git"));
  assert.ok(digest);
  assert.equal(existsSync(wrapperPath), true);
  assert.match(execFileSync(wrapperPath, ["--smoke"], {
    cwd: mount.mountRoot,
    encoding: "utf8",
  }), /SCOUT_ARTIFACT_DIGEST_OK/);
});

test("AssetStore resolves asset-local shell tool commands against the repo root", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-shell-tools-");
  const assetsRoot = join(fixtureRoot, "assets", "codex");
  const toolPath = join(assetsRoot, "tools", "asset-local-tool");
  writeExecutable(toolPath, "ASSET_LOCAL_TOOL_OK");
  writeShellTools(assetsRoot, {
    tools: [
      {
        id: "assetLocalTool",
        name: "asset-local-tool",
        command: "assets/codex/tools/asset-local-tool",
        exposeAs: "asset-local-tool",
        required: true,
      },
    ],
  });
  updateCoordinatorShellTools(assetsRoot, ["assetLocalTool"]);

  const mount = new AssetStore().materializeMount({
    repoRoot: fixtureRoot,
    runId: "run-asset-local-shell-tool-test",
    agentId: "coordinator",
  });
  const wrapperPath = join(mount.mountRoot, "bin", "asset-local-tool");

  assert.ok(readFileSync(wrapperPath, "utf8").includes(toolPath));
  assert.equal(execFileSync(wrapperPath, [], {
    cwd: mount.mountRoot,
    encoding: "utf8",
  }).trim(), "ASSET_LOCAL_TOOL_OK");
});

test("AssetStore resolves asset-local MCP commands against the repo root", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-mcp-command-");
  const assetsRoot = join(fixtureRoot, "assets", "codex");
  const commandPath = join(assetsRoot, "tools", "asset-local-mcp");
  writeExecutable(commandPath, "ASSET_LOCAL_MCP_OK");
  writeMcpServers(assetsRoot, {
    servers: {
      assetLocal: {
        command: "assets/codex/tools/asset-local-mcp",
      },
    },
  });
  updateCoordinatorMcpServers(assetsRoot, ["assetLocal"]);

  const mount = new AssetStore().materializeMount({
    repoRoot: fixtureRoot,
    runId: "run-asset-local-mcp-command-test",
    agentId: "coordinator",
  });
  const server = mount.mcpServers.find((candidate) => candidate.name === "assetLocal");

  assert.ok(server);
  assert.equal(server.command, commandPath);
  assert.equal(execFileSync(server.wrapperPath, [], {
    cwd: mount.mountRoot,
    encoding: "utf8",
  }).trim(), "ASSET_LOCAL_MCP_OK");
});

test("scout-memory reports run-level codex memory files without reading sqlite content", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-shell-tools-");
  const runId = "run-shell-tool-memory-test";
  const mount = new AssetStore().materializeMount({
    repoRoot: fixtureRoot,
    runId,
    agentId: "coordinator",
  });
  const codexHome = join(fixtureRoot, "run", runId, "codex-home", ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "memories_1.sqlite"), "memory-db-placeholder", "utf8");
  writeFileSync(join(codexHome, "state_5.sqlite-wal"), "state-wal-placeholder", "utf8");
  writeFileSync(join(codexHome, "ignored.txt"), "not memory", "utf8");

  const scriptPath = join(repoRoot, "assets", "codex", "tools", "scout-memory.cjs");
  const smoke = execFileSync(process.execPath, [scriptPath, "--smoke"], {
    cwd: mount.mountRoot,
    encoding: "utf8",
  });
  const rawList = execFileSync(process.execPath, [scriptPath, "list"], {
    cwd: mount.mountRoot,
    encoding: "utf8",
  });
  const list = JSON.parse(rawList) as {
    codexHome: string;
    exists: boolean;
    readable: boolean;
    files: Array<{ name: string; kind: string; readable: boolean }>;
  };

  assert.match(smoke, /SCOUT_MEMORY_OK/);
  assert.equal(list.codexHome, realpathSync(codexHome));
  assert.equal(list.exists, true);
  assert.equal(list.readable, true);
  assert.deepEqual(list.files.map((file) => file.name), [
    "memories_1.sqlite",
    "state_5.sqlite-wal",
  ]);
  assert.deepEqual(list.files.map((file) => file.kind), [
    "memories",
    "state",
  ]);
  assert.ok(list.files.every((file) => file.readable));
});

function createCodexAssetFixture(prefix: string): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  return fixtureRoot;
}

function writeShellTools(assetsRoot: string, shellTools: ShellToolsFile): void {
  writeFileSync(join(assetsRoot, "tools", "shell-tools.json"), JSON.stringify(shellTools, null, 2) + "\n", "utf8");
}

function writeMcpServers(assetsRoot: string, mcpServers: McpServersFile): void {
  writeFileSync(join(assetsRoot, "mcp", "servers.json"), JSON.stringify(mcpServers, null, 2) + "\n", "utf8");
}

function writeExecutable(path: string, marker: string): void {
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(marker)}\n`, "utf8");
  chmodSync(path, 0o755);
}

function updateCoordinatorShellTools(assetsRoot: string, shellTools: string[]): void {
  const path = join(assetsRoot, "agents", "agent-profiles.json");
  const profiles = JSON.parse(readFileSync(path, "utf8")) as AgentProfilesFile;
  profiles.profiles.coordinator.shellTools = shellTools;
  writeFileSync(path, JSON.stringify(profiles, null, 2) + "\n", "utf8");
}

function updateCoordinatorMcpServers(assetsRoot: string, mcpServers: string[]): void {
  const path = join(assetsRoot, "agents", "agent-profiles.json");
  const profiles = JSON.parse(readFileSync(path, "utf8")) as AgentProfilesFile;
  profiles.profiles.coordinator.mcpServers = mcpServers;
  writeFileSync(path, JSON.stringify(profiles, null, 2) + "\n", "utf8");
}
