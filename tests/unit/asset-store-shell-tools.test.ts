import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore, type AgentProfilesFile, type MountManifest, type ShellToolsFile } from "../../src/asset-store/index.js";

const repoRoot = process.cwd();

test("AssetStore records unresolved shell tools as issues and excludes them from mount outputs", () => {
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

function updateCoordinatorShellTools(assetsRoot: string, shellTools: string[]): void {
  const path = join(assetsRoot, "agents", "agent-profiles.json");
  const profiles = JSON.parse(readFileSync(path, "utf8")) as AgentProfilesFile;
  profiles.profiles.coordinator.shellTools = shellTools;
  writeFileSync(path, JSON.stringify(profiles, null, 2) + "\n", "utf8");
}
