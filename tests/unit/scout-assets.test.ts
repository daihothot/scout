import assert from "node:assert/strict";
import {
  afterEach,
  test,
} from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const scoutAssetsPath = resolve("assets/codex/tools/scout-assets.cjs");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("scout-assets summary presents current phase, roots, counts, and issues", () => {
  const fixture = createFixture();
  const result = runScoutAssets(fixture.mountRoot, "summary");

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.identity, {
    agentId: "researcher",
    phase: "research",
    mountId: "m_test",
    mountRoot: ".",
  });
  assert.deepEqual(output.counts, {
    skills: 5,
    shellTools: 3,
    mcpServers: 1,
    plugins: 1,
    issues: 1,
  });
  assert.deepEqual(output.roots, {
    runtimeRoots: [
      { name: "mount", path: ".", access: "read" },
      { name: "artifacts", path: "../artifacts", access: "read-write" },
      { name: "tmp", path: "../tmp", access: "read-write" },
    ],
    profileRoots: [
      { source: "~/.shared-source", path: join(homedir(), ".shared-source"), access: "read" },
      { source: "~/.artifacts", path: join(homedir(), ".artifacts"), access: "write" },
    ],
  });
});

test("scout-assets family returns flat names and progressively resolves unique families", () => {
  const fixture = createFixture();
  const families = parseSuccessful(fixture.mountRoot, "family");
  assert.equal(families.phase, "research");
  assert.deepEqual(families.families, [
    "audit",
    "dynamic",
    "internal",
    "runtime-inspector",
    "scout",
    "single",
    "tool",
    "unity",
    "validation",
    "workflow",
  ]);
  assert.equal("parent" in families, false);

  const workflow = parseSuccessful(fixture.mountRoot, "family", "workflow");
  assert.deepEqual(workflow, {
    phase: "research",
    family: "validation/workflow",
    skills: [{
      name: "domain-validation-researcher",
      family: ["validation", "workflow"],
      path: ".scout/skill/validation/workflow/domain-validation-researcher/SKILL.md",
    }],
  });

  const single = parseSuccessful(fixture.mountRoot, "family", "single");
  assert.deepEqual(single, {
    phase: "research",
    family: "validation/single",
    children: ["unity"],
  });
});

test("scout-assets asks for a parent path when a family name is ambiguous", () => {
  const fixture = createFixture();
  const ambiguous = parseSuccessful(fixture.mountRoot, "family", "unity");
  assert.deepEqual(ambiguous, {
    phase: "research",
    family: "unity",
    ambiguous: true,
    candidates: ["audit/unity", "validation/single/unity"],
  });

  const resolved = parseSuccessful(fixture.mountRoot, "family", "validation/single/unity");
  assert.deepEqual(resolved, {
    phase: "research",
    family: "validation/single/unity",
    skills: [{
      name: "validation-single",
      family: ["validation", "single", "unity"],
      path: ".scout/skill/validation/single/unity/validation-single/SKILL.md",
    }],
  });
});

test("scout-assets skill returns metadata and all current phase tools", () => {
  const fixture = createFixture();
  const output = parseSuccessful(fixture.mountRoot, "skill", "domain-validation-researcher");
  assert.equal(output.skill.path, ".scout/skill/validation/workflow/domain-validation-researcher/SKILL.md");
  assert.equal(output.skill.summary, "Validation researcher");
  assert.deepEqual(output.phaseTools.skills, [{
    name: "tool-scout-send-message",
    family: ["tool", "scout", "dynamic"],
    path: ".scout/skill/tool/scout/dynamic/tool-scout-send-message/SKILL.md",
  }]);
  assert.deepEqual(output.phaseTools.shellTools.map((tool: { commandPathKind: string }) => tool.commandPathKind), [
    "path-resolved",
    "absolute",
    "asset-relative",
  ]);
  assert.equal(output.phaseTools.mcpServers[0].name, "jarvis");
});

test("scout-assets plugin returns mounted plugin metadata", () => {
  const fixture = createFixture();
  const output = parseSuccessful(fixture.mountRoot, "plugin", "plugin-a");
  assert.equal(output.plugin.name, "plugin-a");
  assert.equal(output.plugin.path, "plugins/plugin-a");
  assert.equal(output.plugin.metadata.version, "1.2.3");
  assert.equal(output.plugin.metadata.interface.displayName, "Plugin A");
});

test("scout-assets rejects unknown resources, removed commands, and missing manifests", () => {
  const fixture = createFixture();
  const missingSkill = runScoutAssets(fixture.mountRoot, "skill", "missing-skill");
  assert.equal(missingSkill.status, 1);
  assert.match(missingSkill.stderr, /Skill is not materialized for the current role: missing-skill/);

  const removedCommand = runScoutAssets(fixture.mountRoot, "tools");
  assert.equal(removedCommand.status, 1);
  assert.match(removedCommand.stderr, /Usage:/);

  const missingFamily = runScoutAssets(fixture.mountRoot, "family", "missing-family");
  assert.equal(missingFamily.status, 1);
  assert.match(missingFamily.stderr, /Family is not supported for the current phase/);

  const emptyRoot = createTemporaryRoot();
  const missingManifest = runScoutAssets(emptyRoot, "family");
  assert.equal(missingManifest.status, 1);
  assert.match(missingManifest.stderr, /mount-manifest\.json not found/);
});

function createFixture(): {
  mountRoot: string;
  skillLogicalRoot: string;
  skillSourceRoot: string;
} {
  const fixtureRoot = createTemporaryRoot();
  const mountRoot = join(fixtureRoot, "mount");
  const skillLogicalRoot = ".scout/skill/internal/runtime-inspector/internal-runtime-inspector";
  const skillSourceRoot = join(fixtureRoot, "skill-source");
  mkdirSync(mountRoot);
  mkdirSync(skillSourceRoot);
  writeFileSync(join(skillSourceRoot, "SKILL.md"), "# Runtime Inspector\n", "utf8");
  mkdirSync(dirname(join(mountRoot, skillLogicalRoot)), { recursive: true });
  symlinkSync(skillSourceRoot, join(mountRoot, skillLogicalRoot));
  mkdirSync(join(mountRoot, "plugins", "plugin-a", ".codex-plugin"), { recursive: true });
  writeFileSync(join(mountRoot, "plugins", "plugin-a", ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "plugin-a",
    version: "1.2.3",
    description: "Fixture plugin",
    interface: { displayName: "Plugin A" },
  }), "utf8");

  writeFileSync(join(mountRoot, "mount-manifest.json"), JSON.stringify({
    resourceInventoryVersion: 1,
    agentId: "researcher",
    assetCommitId: "ac_test",
    mountId: "m_test",
    agentProfile: { phase: "research" },
    mountRoot: ".",
    profileReadableRoots: ["~/.shared-source"],
    profileWritableRoots: ["~/.artifacts"],
    runtimeRoots: [
      { name: "mount", path: ".", access: "read" },
      { name: "artifacts", path: "../artifacts", access: "read-write" },
      { name: "tmp", path: "../tmp", access: "read-write" },
    ],
    resourceHash: "resource-hash",
    generatedAt: "2026-08-25T00:00:00.000Z",
    issues: [{
      severity: "warning",
      code: "shell_tool_unresolved",
      message: "Optional Tool is unavailable",
      resourceId: "optional-tool",
    }],
    assets: [],
    linkedFiles: [{ path: "AGENTS.md", sourcePath: "assets/codex/agents/AGENTS.md", hash: "hash" }],
    generatedFiles: [{ path: "bin/scout-assets", hash: "hash" }],
    shellTools: [{
      id: "scoutAssets",
      exposeAs: "scout-assets",
      wrapperPath: "bin/scout-assets",
      command: "node",
      required: true,
    }, {
      id: "git",
      exposeAs: "git",
      wrapperPath: "bin/git",
      command: "/usr/bin/git",
      required: true,
    }, {
      id: "rg",
      exposeAs: "rg",
      wrapperPath: "bin/rg",
      command: "assets/codex/tools/ripgrep/rg",
      required: true,
    }],
    mcpServers: [{
      name: "jarvis",
      wrapperPath: "mcp/jarvis",
      command: "node",
      args: [],
      writableRoots: [],
    }],
    customAgents: [],
    skills: [{
      name: "internal-runtime-inspector",
      description: "Inspect Runtime resources",
      summary: "Inspect Runtime resources",
      phase: ["research"],
      family: ["internal", "runtime-inspector"],
      requiredSkills: [],
      path: `${skillLogicalRoot}/SKILL.md`,
    }, {
      name: "validation-single",
      description: "Validation single",
      summary: "Validation single",
      phase: ["research"],
      family: ["validation", "single", "unity"],
      requiredSkills: [],
      path: ".scout/skill/validation/single/unity/validation-single/SKILL.md",
    }, {
      name: "domain-validation-researcher",
      description: "Validation researcher",
      summary: "Validation researcher",
      phase: ["research"],
      family: ["validation", "workflow"],
      requiredSkills: [],
      path: ".scout/skill/validation/workflow/domain-validation-researcher/SKILL.md",
    }, {
      name: "tool-scout-send-message",
      description: "Send Message tool",
      summary: "Send Message tool",
      phase: ["research"],
      family: ["tool", "scout", "dynamic"],
      requiredSkills: [],
      path: ".scout/skill/tool/scout/dynamic/tool-scout-send-message/SKILL.md",
    }, {
      name: "audit-unity",
      description: "Audit Unity",
      summary: "Audit Unity",
      phase: ["research"],
      family: ["audit", "unity"],
      requiredSkills: [],
      path: ".scout/skill/audit/unity/audit-unity/SKILL.md",
    }],
    plugins: ["plugin-a"],
    roleAgents: { researcher: "agents/researcher.AGENTS.md" },
  }, null, 2));

  return { mountRoot, skillLogicalRoot, skillSourceRoot };
}

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "scout-assets-test-"));
  fixtureRoots.push(root);
  return root;
}

function parseSuccessful(cwd: string, ...args: string[]): any {
  const result = runScoutAssets(cwd, ...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runScoutAssets(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [scoutAssetsPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}
