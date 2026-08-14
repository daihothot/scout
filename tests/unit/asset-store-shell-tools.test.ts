import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  AssetStore,
  inspectCodexMount,
  materializeCodexMount,
  prepareCodexMount,
  type AgentProfilesFile,
  type CodexMount,
  type McpServersFile,
  type MountManifest,
  type ShellToolsFile,
} from "../../src/asset-store/index.js";
import { MountInspector } from "../../src/asset-store/inspection/mount-inspector.js";

const scoutRoot = process.cwd();

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
    scoutRoot: fixtureRoot,
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

test("AssetStore rejects asset-local paths that escape the assets root", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-asset-path-boundary-");
  const assetsRoot = join(fixtureRoot, "assets", "codex");
  writeShellTools(assetsRoot, {
    tools: [{
      id: "escapingAsset",
      name: "escaping-asset",
      command: "node",
      args: ["assets/codex/../../outside.cjs"],
      exposeAs: "escaping-asset",
      required: true,
    }],
  });
  updateCoordinatorShellTools(assetsRoot, ["escapingAsset"]);

  assert.throws(
    () => new AssetStore().inspectMount({
      scoutRoot: fixtureRoot,
      runId: "run-asset-path-boundary",
      agentId: "coordinator",
    }),
    /Asset-local path escapes assets root/,
  );
});

test("AssetStore rejects shell and MCP names that are not single path segments", () => {
  const shellFixture = createCodexAssetFixture("scout-asset-store-shell-name-boundary-");
  const shellAssetsRoot = join(shellFixture, "assets", "codex");
  writeShellTools(shellAssetsRoot, {
    tools: [{
      id: "escapingName",
      name: "escaping-name",
      command: "node",
      exposeAs: "../escaping-name",
      required: true,
    }],
  });
  updateCoordinatorShellTools(shellAssetsRoot, ["escapingName"]);
  assert.throws(
    () => new AssetStore().inspectMount({
      scoutRoot: shellFixture,
      runId: "run-shell-name-boundary",
      agentId: "coordinator",
    }),
    /Invalid shell tool exposeAs/,
  );

  const mcpFixture = createCodexAssetFixture("scout-asset-store-mcp-name-boundary-");
  const mcpAssetsRoot = join(mcpFixture, "assets", "codex");
  writeMcpServers(mcpAssetsRoot, {
    servers: {
      "../escaping-server": { command: "node" },
    },
  });
  updateCoordinatorMcpServers(mcpAssetsRoot, ["../escaping-server"]);
  assert.throws(
    () => new AssetStore().inspectMount({
      scoutRoot: mcpFixture,
      runId: "run-mcp-name-boundary",
      agentId: "coordinator",
    }),
    /Invalid MCP server name/,
  );
});

test("AssetStore rejects dot agent ids before materializing a mount", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-agent-id-boundary-");
  const store = new AssetStore();

  for (const [agentId, runId] of [
    [".", "run-dot-agent-id"],
    ["..", "run-parent-agent-id"],
  ] as const) {
    assert.throws(
      () => store.materializeMount({
        scoutRoot: fixtureRoot,
        runId,
        agentId,
      }),
      /Invalid agentId/,
    );
    assert.equal(existsSync(join(fixtureRoot, "run", runId)), false);
  }
});

test("AssetStore rejects run ids that escape the run directory", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-run-id-boundary-");
  const store = new AssetStore();
  const escapedRunName = `${basename(fixtureRoot)}-escaped`;

  for (const runId of [`../${escapedRunName}`, `../../${escapedRunName}`] as const) {
    assert.throws(
      () => store.materializeMount({
        scoutRoot: fixtureRoot,
        runId,
        agentId: "coordinator",
      }),
      /Invalid runId/,
    );
  }
  assert.equal(existsSync(join(fixtureRoot, escapedRunName)), false);
  assert.equal(existsSync(join(fixtureRoot, "..", escapedRunName)), false);
});

test("AssetStore reuses a valid mount without touching mountRoot", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-mount-reuse-");
  const store = new AssetStore();
  const initial = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-mount-reuse",
    agentId: "coordinator",
  });
  const sentinelPath = join(initial.mountRoot, "sentinel.txt");
  writeFileSync(sentinelPath, "preserve\n", "utf8");

  const prepared = store.prepareMount({
    scoutRoot: fixtureRoot,
    runId: "run-mount-reuse",
    agentId: "coordinator",
    persistedIdentity: {
      assetCommitId: initial.assetCommitId,
      parentAssetCommitId: initial.parentAssetCommitId,
      mountId: initial.mountId,
      resourceHash: initial.resourceHash,
    },
  });

  assert.equal(prepared.decision, "reused");
  assert.equal(prepared.mount.mountRoot, initial.mountRoot);
  assert.equal(readFileSync(sentinelPath, "utf8"), "preserve\n");
});

test("materialize facade preserves the inspect-to-prepare reuse handoff", () => {
  const fixtureRoot = createCodexAssetFixture("scout-mount-facade-reuse-");
  const initial = materializeCodexMount({
    scoutRoot: fixtureRoot,
    runId: "run-mount-facade-reuse",
    agentId: "coordinator",
  });
  const sentinelPath = join(initial.mountRoot, "sentinel.txt");
  writeFileSync(sentinelPath, "preserve\n", "utf8");
  const options = {
    scoutRoot: fixtureRoot,
    runId: "run-mount-facade-reuse",
    agentId: "coordinator",
    persistedIdentity: {
      assetCommitId: initial.assetCommitId,
      parentAssetCommitId: initial.parentAssetCommitId,
      mountId: initial.mountId,
      resourceHash: initial.resourceHash,
    },
  };

  assert.deepEqual(inspectCodexMount(options), { decision: "reused", reason: undefined });
  const prepared = prepareCodexMount(options);

  assert.equal(prepared.decision, "reused");
  assert.equal(prepared.mount.mountRoot, initial.mountRoot);
  assert.equal(readFileSync(sentinelPath, "utf8"), "preserve\n");
});

test("AssetStore does not repeat mount inspection when prepare adds a step observer", () => {
  const fixtureRoot = createCodexAssetFixture("scout-mount-inspection-cache-");
  const store = new AssetStore();
  const initial = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-mount-inspection-cache",
    agentId: "coordinator",
  });
  const options = {
    scoutRoot: fixtureRoot,
    runId: "run-mount-inspection-cache",
    agentId: "coordinator",
    persistedIdentity: {
      assetCommitId: initial.assetCommitId,
      parentAssetCommitId: initial.parentAssetCommitId,
      mountId: initial.mountId,
      resourceHash: initial.resourceHash,
    },
  };
  const originalInspect = MountInspector.prototype.inspect;
  let inspectionCount = 0;
  MountInspector.prototype.inspect = function () {
    inspectionCount += 1;
    return originalInspect.call(this);
  };
  try {
    assert.equal(store.inspectMount(options).decision, "reused");
    const prepared = store.prepareMount(options, () => undefined);
    assert.equal(prepared.decision, "reused");
    assert.equal(inspectionCount, 1);
  } finally {
    MountInspector.prototype.inspect = originalInspect;
  }
});

test("AssetStore rechecks a cached inspection when the mount changes before prepare", () => {
  const fixtureRoot = createCodexAssetFixture("scout-mount-inspection-drift-");
  const store = new AssetStore();
  const initial = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-mount-inspection-drift",
    agentId: "coordinator",
  });
  const options = {
    scoutRoot: fixtureRoot,
    runId: "run-mount-inspection-drift",
    agentId: "coordinator",
    cleanRunRoot: false,
    persistedIdentity: {
      assetCommitId: initial.assetCommitId,
      parentAssetCommitId: initial.parentAssetCommitId,
      mountId: initial.mountId,
      resourceHash: initial.resourceHash,
    },
  };
  const originalInspect = MountInspector.prototype.inspect;
  let inspectionCount = 0;
  MountInspector.prototype.inspect = function () {
    inspectionCount += 1;
    return originalInspect.call(this);
  };
  try {
    assert.equal(store.inspectMount(options).decision, "reused");
    const configPath = join(initial.mountRoot, ".codex", "config.toml");
    writeFileSync(configPath, readFileSync(configPath, "utf8") + "# changed\n", "utf8");
    const prepared = store.prepareMount(options, () => undefined);
    assert.equal(prepared.decision, "rebuild");
    assert.equal(inspectionCount, 2);
  } finally {
    MountInspector.prototype.inspect = originalInspect;
  }
});

test("AssetStore rechecks cached inspection when artifact or log roots change", () => {
  const originalInspect = MountInspector.prototype.inspect;
  let inspectionCount = 0;
  MountInspector.prototype.inspect = function () {
    inspectionCount += 1;
    return originalInspect.call(this);
  };
  try {
    for (const rootName of ["artifactRoot", "logsRoot"] as const) {
      const fixtureRoot = createCodexAssetFixture(`scout-mount-${rootName}-drift-`);
      const store = new AssetStore();
      const initial = store.materializeMount({
        scoutRoot: fixtureRoot,
        runId: `run-mount-${rootName}-drift`,
        agentId: "coordinator",
      });
      const options = {
        scoutRoot: fixtureRoot,
        runId: `run-mount-${rootName}-drift`,
        agentId: "coordinator",
        cleanRunRoot: false,
        persistedIdentity: mountIdentity(initial),
      };
      const before = inspectionCount;
      assert.equal(store.inspectMount(options).decision, "reused");
      rmSync(initial[rootName], { recursive: true });
      mkdirSync(initial[rootName]);

      const prepared = store.prepareMount(options);

      assert.equal(prepared.decision, "reused");
      assert.equal(inspectionCount, before + 2);
    }
  } finally {
    MountInspector.prototype.inspect = originalInspect;
  }
});

test("AssetStore rechecks cached inspection when the Scout assets link changes", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-assets-link-drift-"));
  const assetSource = join(fixtureRoot, "asset-source");
  const assetAlias = join(fixtureRoot, "asset-alias");
  cpSync(join(scoutRoot, "assets"), assetSource, { recursive: true });
  symlinkSync(assetSource, assetAlias);
  symlinkSync(assetSource, join(fixtureRoot, "assets"));
  const store = new AssetStore();
  const initial = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-assets-link-drift",
    agentId: "coordinator",
  });
  const options = {
    scoutRoot: fixtureRoot,
    runId: "run-assets-link-drift",
    agentId: "coordinator",
    cleanRunRoot: false,
    persistedIdentity: mountIdentity(initial),
  };
  const originalInspect = MountInspector.prototype.inspect;
  let inspectionCount = 0;
  MountInspector.prototype.inspect = function () {
    inspectionCount += 1;
    return originalInspect.call(this);
  };
  try {
    assert.equal(store.inspectMount(options).decision, "reused");
    unlinkSync(join(fixtureRoot, "assets"));
    symlinkSync(assetAlias, join(fixtureRoot, "assets"));

    const prepared = store.prepareMount(options);

    assert.equal(prepared.decision, "reused");
    assert.equal(inspectionCount, 2);
  } finally {
    MountInspector.prototype.inspect = originalInspect;
  }
});

test("AssetStore rechecks cached inspection when current-device command binding changes", () => {
  const fixtureRoot = createCodexAssetFixture("scout-runtime-binding-cache-");
  const assetsRoot = join(fixtureRoot, "assets", "codex");
  const firstBin = join(fixtureRoot, "first-bin");
  const secondBin = join(fixtureRoot, "second-bin");
  const command = "scout-runtime-binding-probe";
  mkdirSync(firstBin, { recursive: true });
  mkdirSync(secondBin, { recursive: true });
  writeExecutable(join(firstBin, command), "FIRST_BINDING");
  writeExecutable(join(secondBin, command), "SECOND_BINDING");
  writeShellTools(assetsRoot, {
    tools: [{
      id: "runtimeBindingProbe",
      name: "runtime-binding-probe",
      command,
      exposeAs: command,
      required: true,
    }],
  });
  updateCoordinatorShellTools(assetsRoot, ["runtimeBindingProbe"]);

  const originalPath = process.env.PATH;
  const originalInspect = MountInspector.prototype.inspect;
  let inspectionCount = 0;
  MountInspector.prototype.inspect = function () {
    inspectionCount += 1;
    return originalInspect.call(this);
  };
  try {
    process.env.PATH = `${firstBin}:${secondBin}`;
    const store = new AssetStore();
    const initial = store.materializeMount({
      scoutRoot: fixtureRoot,
      runId: "run-runtime-binding-cache",
      agentId: "coordinator",
    });
    const options = {
      scoutRoot: fixtureRoot,
      runId: "run-runtime-binding-cache",
      agentId: "coordinator",
      cleanRunRoot: false,
      persistedIdentity: mountIdentity(initial),
    };
    assert.equal(store.inspectMount(options).decision, "reused");
    process.env.PATH = `${secondBin}:${firstBin}`;

    const prepared = store.prepareMount(options);

    assert.equal(prepared.decision, "rebuild");
    assert.equal(inspectionCount, 2);
    assert.equal(execFileSync(join(prepared.mount.mountRoot, "bin", command), [], {
      encoding: "utf8",
    }).trim(), "SECOND_BINDING");
  } finally {
    MountInspector.prototype.inspect = originalInspect;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("AssetStore compares persisted manifest objects by semantics rather than key order", () => {
  const fixtureRoot = createCodexAssetFixture("scout-mount-semantic-comparison-");
  const store = new AssetStore();
  const initial = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-mount-semantic-comparison",
    agentId: "coordinator",
  });
  const manifest = JSON.parse(readFileSync(initial.manifestPath, "utf8")) as MountManifest;
  manifest.agentProfile = reverseObjectKeys(manifest.agentProfile);
  manifest.agentProfile.readableRoots?.reverse();
  manifest.agentProfile.writableRoots?.reverse();
  manifest.readableRoots.reverse();
  manifest.writableRoots.reverse();
  manifest.roleAgents = reverseObjectKeys(manifest.roleAgents);
  manifest.mcpServers = manifest.mcpServers
    .map((server) => ({
      ...reverseObjectKeys(server),
      writableRoots: [...server.writableRoots].reverse(),
    }))
    .reverse();
  writeManifest(initial.manifestPath, manifest);

  const inspection = store.inspectMount({
    scoutRoot: fixtureRoot,
    runId: "run-mount-semantic-comparison",
    agentId: "coordinator",
    persistedManifest: manifest,
    persistedIdentity: {
      assetCommitId: initial.assetCommitId,
      parentAssetCommitId: initial.parentAssetCommitId,
      mountId: initial.mountId,
      resourceHash: initial.resourceHash,
    },
  });

  assert.deepEqual(inspection, { decision: "reused", reason: undefined });
});

test("AssetStore validates config assignments instead of matching path substrings", () => {
  const fixtureRoot = createCodexAssetFixture("scout-mount-config-structure-");
  const store = new AssetStore();
  const initial = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-mount-config-structure",
    agentId: "coordinator",
  });
  const manifest = JSON.parse(readFileSync(initial.manifestPath, "utf8")) as MountManifest;
  const configPath = join(initial.mountRoot, ".codex", "config.toml");
  const misleadingConfig = [
    `# expected mount: ${initial.mountRoot}`,
    `# expected run: ${initial.runRoot}`,
    `# expected artifacts: ${initial.artifactRoot}`,
    "[shell_environment_policy.set]",
    "PATH = \"/wrong/mount/bin\"",
    "SCOUT_RUN_ROOT = \"/wrong/run\"",
    "SCOUT_ARTIFACT_ROOT = \"/wrong/artifacts\"",
    "SCOUT_RUN_ID = \"wrong-run\"",
    "SCOUT_ASSET_COMMIT_ID = \"wrong-commit\"",
    "",
  ].join("\n");
  writeFileSync(configPath, misleadingConfig, "utf8");
  const configEntry = manifest.generatedFiles.find((file) => file.path === ".codex/config.toml");
  assert.ok(configEntry);
  configEntry.hash = sha256FileForTest(configPath);
  writeManifest(initial.manifestPath, manifest);

  const inspection = store.inspectMount({
    scoutRoot: fixtureRoot,
    runId: "run-mount-config-structure",
    agentId: "coordinator",
    persistedManifest: manifest,
    persistedIdentity: {
      assetCommitId: initial.assetCommitId,
      parentAssetCommitId: initial.parentAssetCommitId,
      mountId: initial.mountId,
      resourceHash: initial.resourceHash,
    },
  });

  assert.equal(inspection.decision, "rebuild");
  assert.match(inspection.reason ?? "", /config value changed: PATH/);
});

test("AssetStore reports the failing generated file and errno during inspection", () => {
  const fixtureRoot = createCodexAssetFixture("scout-mount-inspection-diagnostic-");
  const store = new AssetStore();
  const initial = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-mount-inspection-diagnostic",
    agentId: "coordinator",
  });
  const hooksPath = join(initial.mountRoot, ".codex", "hooks.json");
  unlinkSync(hooksPath);

  const inspection = store.inspectMount({
    scoutRoot: fixtureRoot,
    runId: "run-mount-inspection-diagnostic",
    agentId: "coordinator",
    persistedIdentity: {
      assetCommitId: initial.assetCommitId,
      parentAssetCommitId: initial.parentAssetCommitId,
      mountId: initial.mountId,
      resourceHash: initial.resourceHash,
    },
  });

  assert.equal(inspection.decision, "rebuild");
  assert.match(inspection.reason ?? "", /generated runtime files failed/);
  assert.match(inspection.reason ?? "", /ENOENT/);
  assert.match(inspection.reason ?? "", /hooks\.json/);
  assert.doesNotMatch(inspection.reason ?? "", /^mount verification failed$/);
});

test("AssetStore rebuilds an invalid mount manifest with its parse diagnostic", () => {
  const fixtureRoot = createCodexAssetFixture("scout-invalid-mount-manifest-");
  const store = new AssetStore();
  const initial = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-invalid-mount-manifest",
    agentId: "coordinator",
  });
  writeFileSync(initial.manifestPath, "{ invalid json\n", "utf8");

  const prepared = store.prepareMount({
    scoutRoot: fixtureRoot,
    runId: "run-invalid-mount-manifest",
    agentId: "coordinator",
    cleanRunRoot: false,
    persistedIdentity: mountIdentity(initial),
  });

  assert.equal(prepared.decision, "rebuild");
  assert.match(prepared.reason ?? "", /manifest JSON parse failed/);
  assert.doesNotThrow(() => JSON.parse(readFileSync(prepared.mount.manifestPath, "utf8")));
});

for (const runtimeResource of [
  {
    name: "shell tool",
    agentId: "coordinator",
    wrapperPath(manifest: MountManifest): string {
      const tool = manifest.shellTools[0];
      assert.ok(tool);
      return tool.wrapperPath;
    },
    reason: /shell tool wrapper changed for current device/,
  },
  {
    name: "MCP",
    agentId: "verifier",
    wrapperPath(manifest: MountManifest): string {
      const server = manifest.mcpServers[0];
      assert.ok(server);
      return server.wrapperPath;
    },
    reason: /MCP wrapper changed for current device/,
  },
] as const) {
  test(`AssetStore rejects a ${runtimeResource.name} wrapper whose manifest hash was also changed`, () => {
    const fixtureRoot = createCodexAssetFixture(
      `scout-${runtimeResource.name.replace(" ", "-")}-canonical-`,
    );
    const runId = `run-${runtimeResource.name.replace(" ", "-")}-canonical`;
    const store = new AssetStore();
    const initial = store.materializeMount({
      scoutRoot: fixtureRoot,
      runId,
      agentId: runtimeResource.agentId,
    });
    const manifest = JSON.parse(readFileSync(initial.manifestPath, "utf8")) as MountManifest;
    const relativeWrapperPath = runtimeResource.wrapperPath(manifest);
    const wrapperPath = join(initial.mountRoot, relativeWrapperPath);
    const tamperedContent = "#!/bin/sh\nprintf 'tampered\\n'\n";
    writeFileSync(wrapperPath, tamperedContent, "utf8");
    const generated = manifest.generatedFiles.find((file) => file.path === relativeWrapperPath);
    assert.ok(generated);
    generated.hash = sha256FileForTest(wrapperPath);
    writeManifest(initial.manifestPath, manifest);
    const options = {
      scoutRoot: fixtureRoot,
      runId,
      agentId: runtimeResource.agentId,
      cleanRunRoot: false,
      persistedIdentity: mountIdentity(initial),
    };

    const inspection = store.inspectMount(options);
    const prepared = store.prepareMount(options);

    assert.equal(inspection.decision, "rebuild");
    assert.match(inspection.reason ?? "", runtimeResource.reason);
    assert.equal(prepared.decision, "rebuild");
    assert.notEqual(readFileSync(wrapperPath, "utf8"), tamperedContent);
  });

  test(`AssetStore rebuilds a non-executable ${runtimeResource.name} wrapper`, () => {
    const fixtureRoot = createCodexAssetFixture(
      `scout-${runtimeResource.name.replace(" ", "-")}-mode-`,
    );
    const runId = `run-${runtimeResource.name.replace(" ", "-")}-mode`;
    const store = new AssetStore();
    const initial = store.materializeMount({
      scoutRoot: fixtureRoot,
      runId,
      agentId: runtimeResource.agentId,
    });
    const manifest = JSON.parse(readFileSync(initial.manifestPath, "utf8")) as MountManifest;
    chmodSync(join(initial.mountRoot, runtimeResource.wrapperPath(manifest)), 0o644);

    const inspection = store.inspectMount({
      scoutRoot: fixtureRoot,
      runId,
      agentId: runtimeResource.agentId,
      persistedIdentity: mountIdentity(initial),
    });

    assert.equal(inspection.decision, "rebuild");
    assert.match(inspection.reason ?? "", /wrapper is not executable/);
  });
}

for (const relativePath of [
  ".codex/hooks.json",
  ".agents/plugins/marketplace.json",
] as const) {
  test(`AssetStore rejects canonical ${relativePath} drift even when its manifest hash also changed`, () => {
    const fixtureRoot = createCodexAssetFixture("scout-generated-file-canonical-");
    const runId = `run-generated-${relativePath.split("/").at(-1)}`;
    const store = new AssetStore();
    const initial = store.materializeMount({
      scoutRoot: fixtureRoot,
      runId,
      agentId: "coordinator",
    });
    const manifest = JSON.parse(readFileSync(initial.manifestPath, "utf8")) as MountManifest;
    const generatedPath = join(initial.mountRoot, relativePath);
    writeFileSync(generatedPath, "{\n  \"tampered\": true\n}\n", "utf8");
    const generated = manifest.generatedFiles.find((file) => file.path === relativePath);
    assert.ok(generated);
    generated.hash = sha256FileForTest(generatedPath);
    writeManifest(initial.manifestPath, manifest);

    const inspection = store.inspectMount({
      scoutRoot: fixtureRoot,
      runId,
      agentId: "coordinator",
      persistedIdentity: mountIdentity(initial),
    });

    assert.equal(inspection.decision, "rebuild");
    assert.match(inspection.reason ?? "", /changed from canonical content/);
  });
}

test("AssetStore rebuilds only a damaged mount and preserves its identity", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-mount-rebuild-");
  const store = new AssetStore();
  const initial = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-mount-rebuild",
    agentId: "coordinator",
  });
  writeFileSync(join(initial.mountRoot, ".codex", "config.toml"), "damaged\n", "utf8");

  const prepared = store.prepareMount({
    scoutRoot: fixtureRoot,
    runId: "run-mount-rebuild",
    agentId: "coordinator",
    cleanRunRoot: false,
    persistedIdentity: {
      assetCommitId: initial.assetCommitId,
      parentAssetCommitId: initial.parentAssetCommitId,
      mountId: initial.mountId,
      resourceHash: initial.resourceHash,
    },
  });

  assert.equal(prepared.decision, "rebuild");
  assert.equal(prepared.mount.assetCommitId, initial.assetCommitId);
  assert.equal(prepared.mount.mountId, initial.mountId);
  assert.match(readFileSync(join(initial.mountRoot, ".codex", "config.toml"), "utf8"), /SCOUT_RUN_ROOT/);
});

test("AssetStore rebuilds when persisted mount inventory loses a profiled skill", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-inventory-");
  const store = new AssetStore();
  const initial = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-mount-inventory",
    agentId: "coordinator",
  });
  const manifest = JSON.parse(readFileSync(initial.manifestPath, "utf8")) as MountManifest;
  manifest.skills = [];
  writeFileSync(initial.manifestPath, JSON.stringify(manifest, null, 2) + "\\n", "utf8");

  const prepared = store.prepareMount({
    scoutRoot: fixtureRoot,
    runId: "run-mount-inventory",
    agentId: "coordinator",
    cleanRunRoot: false,
    persistedManifest: manifest,
    persistedIdentity: {
      assetCommitId: initial.assetCommitId,
      parentAssetCommitId: initial.parentAssetCommitId,
      mountId: initial.mountId,
      resourceHash: initial.resourceHash,
    },
  });

  assert.equal(prepared.decision, "rebuild");
  const rebuilt = JSON.parse(readFileSync(prepared.mount.manifestPath, "utf8")) as MountManifest;
  assert.deepEqual(rebuilt.skills, initial.skills);
});

for (const mutation of [
  {
    name: "asset hash",
    apply(asset: MountManifest["assets"][number]): void {
      asset.hash = "tampered-asset-hash";
    },
  },
  {
    name: "asset type",
    apply(asset: MountManifest["assets"][number]): void {
      asset.type = "tampered_asset_type";
    },
  },
  {
    name: "asset id",
    apply(asset: MountManifest["assets"][number]): void {
      asset.id = "tampered.asset.id";
    },
  },
] as const) {
  test(`AssetStore rebuilds when persisted ${mutation.name} changes`, () => {
    const fixtureRoot = createCodexAssetFixture(`scout-asset-store-${mutation.name.replace(" ", "-")}-`);
    const store = new AssetStore();
    const initial = store.materializeMount({
      scoutRoot: fixtureRoot,
      runId: `run-mount-${mutation.name.replace(" ", "-")}`,
      agentId: "coordinator",
    });
    const manifest = JSON.parse(readFileSync(initial.manifestPath, "utf8")) as MountManifest;
    const asset = manifest.assets.find((candidate) => candidate.id !== "codex.shell_tools");
    assert.ok(asset);
    mutation.apply(asset);
    writeManifest(initial.manifestPath, manifest);

    const prepared = store.prepareMount({
      scoutRoot: fixtureRoot,
      runId: `run-mount-${mutation.name.replace(" ", "-")}`,
      agentId: "coordinator",
      cleanRunRoot: false,
      persistedManifest: manifest,
      persistedIdentity: {
        assetCommitId: initial.assetCommitId,
        parentAssetCommitId: initial.parentAssetCommitId,
        mountId: initial.mountId,
        resourceHash: initial.resourceHash,
      },
    });

    assert.equal(prepared.decision, "rebuild");
  });
}

test("AssetStore ignores only the shell-tools registry hash when reusing a mount", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-shell-registry-reuse-");
  const store = new AssetStore();
  const initial = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-shell-registry-reuse",
    agentId: "coordinator",
  });
  const manifest = JSON.parse(readFileSync(initial.manifestPath, "utf8")) as MountManifest;
  const registry = manifest.assets.find((asset) => asset.id === "codex.shell_tools");
  assert.ok(registry);
  registry.hash = "device-specific-registry-hash";
  writeManifest(initial.manifestPath, manifest);

  const prepared = store.prepareMount({
    scoutRoot: fixtureRoot,
    runId: "run-shell-registry-reuse",
    agentId: "coordinator",
    cleanRunRoot: false,
    persistedManifest: manifest,
    persistedIdentity: {
      assetCommitId: initial.assetCommitId,
      parentAssetCommitId: initial.parentAssetCommitId,
      mountId: initial.mountId,
      resourceHash: initial.resourceHash,
    },
  });

  assert.equal(prepared.decision, "reused");
});

test("AssetStore exposes scout-memory for all agent mounts", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-shell-tools-");
  const store = new AssetStore();

  for (const agentId of ["coordinator", "researcher", "verifier", "validator"]) {
    const mount = store.materializeMount({
      scoutRoot: fixtureRoot,
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
    scoutRoot: fixtureRoot,
    runId: "run-shell-tool-coordinator-readers-test",
    agentId: "coordinator",
  });
  const manifest = JSON.parse(readFileSync(mount.manifestPath, "utf8")) as MountManifest;

  for (const tool of ["cat", "sed", "pwd"]) {
    assert.ok(mount.shellTools.some((candidate) => candidate.id === tool));
    assert.ok(manifest.shellTools.some((candidate) => candidate.exposeAs === tool));
    assert.equal(existsSync(join(mount.mountRoot, "bin", tool)), true);
  }
});

test("AssetStore exposes profiled Validation Domain Skills outside Codex Skill discovery", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-validation-skills-");
  const expectedSkills = {
    coordinator: "domain-validation-coordinator",
    researcher: "domain-validation-researcher",
    verifier: "domain-validation-verifier",
    validator: "domain-validation-validator",
  } as const;
  const store = new AssetStore();

  for (const [agentId, skill] of Object.entries(expectedSkills)) {
    const mount = store.materializeMount({
      scoutRoot: fixtureRoot,
      runId: `run-validation-skill-${agentId}-test`,
      agentId,
    });
    const manifest = JSON.parse(readFileSync(mount.manifestPath, "utf8")) as MountManifest;

    assert.ok(mount.skills.includes(skill));
    assert.ok(manifest.skills.includes(skill));
    assert.equal(existsSync(join(
      mount.mountRoot,
      ".scout",
      "skills",
      skill,
      "SKILL.md",
    )), true);
    assert.deepEqual(readdirSync(join(mount.mountRoot, ".agents", "skills")), []);
  }
});

test("AssetStore keeps the profiled Skill catalog in memory without exposing it in the mount", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-skill-catalog-");
  const store = new AssetStore();
  const mount = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-skill-catalog-test",
    agentId: "researcher",
  });
  const manifest = JSON.parse(readFileSync(mount.manifestPath, "utf8")) as MountManifest & {
    skillCatalog?: unknown;
  };
  const catalogPath = join(mount.mountRoot, ".scout", "skill-catalog.json");

  assert.equal(existsSync(catalogPath), false);
  assert.equal("skillCatalog" in manifest, false);
  assert.deepEqual(mount.skillCatalog.map((skill) => skill.name), mount.skills);
  assert.deepEqual(readdirSync(join(mount.mountRoot, ".agents", "skills")), []);
  const entrySkill = mount.skillCatalog.find((skill) => skill.name === "domain-validation-researcher");
  const serviceSkill = mount.skillCatalog.find((skill) =>
    skill.name === "domain-validation-research-pack"
  );
  assert.ok(entrySkill);
  assert.deepEqual(entrySkill.family, ["validation", "workflow", "researcher"]);
  assert.deepEqual(entrySkill.tags, ["scout", "validation", "bdd", "research", "workflow"]);
  assert.ok(serviceSkill);
  assert.equal(serviceSkill.family, undefined);
  assert.deepEqual(serviceSkill.tags, [
    "scout",
    "validation",
    "research",
    "pack",
    "evidence",
    "manual",
  ]);
  assert.ok(mount.skillCatalog.every((skill) =>
    skill.path === `.scout/skills/${skill.name}/SKILL.md`
    && existsSync(join(mount.mountRoot, skill.path))
  ));

  for (const skill of mount.skillCatalog) {
    assert.equal(
      realpathSync(join(mount.mountRoot, ".scout", "skills", skill.name)),
      realpathSync(join(fixtureRoot, "assets", "codex", "skills", skill.name)),
    );
  }

  const reused = store.prepareMount({
    scoutRoot: fixtureRoot,
    runId: "run-skill-catalog-test",
    agentId: "researcher",
    cleanRunRoot: false,
    persistedIdentity: mountIdentity(mount),
  });
  assert.equal(reused.decision, "reused");
  assert.deepEqual(reused.mount.skillCatalog, mount.skillCatalog);
});

test("Skill resource hashes cover the complete profiled Skill directory", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-skill-resource-hash-");
  const store = new AssetStore();
  const before = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-skill-resource-hash-before-test",
    agentId: "researcher",
  });
  const beforeManifest = JSON.parse(readFileSync(before.manifestPath, "utf8")) as MountManifest;
  const skillId = "codex.skill.domain-validation-research-pack";
  const beforeAsset = beforeManifest.assets.find((asset) => asset.id === skillId);
  assert.ok(beforeAsset);
  assert.equal(
    beforeAsset.sourcePath,
    "assets/codex/skills/domain-validation-research-pack",
  );

  const templatePath = join(
    fixtureRoot,
    "assets",
    "codex",
    "skills",
    "domain-validation-research-pack",
    "templates",
    "verification-manual.md",
  );
  writeFileSync(templatePath, `${readFileSync(templatePath, "utf8")}\nresource hash probe\n`, "utf8");

  const after = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-skill-resource-hash-after-test",
    agentId: "researcher",
  });
  const afterManifest = JSON.parse(readFileSync(after.manifestPath, "utf8")) as MountManifest;
  const afterAsset = afterManifest.assets.find((asset) => asset.id === skillId);
  assert.ok(afterAsset);
  assert.notEqual(after.resourceHash, before.resourceHash);
  assert.notEqual(afterAsset.hash, beforeAsset.hash);
});

test("AssetStore mounts configured Unity Signals for Worker roles only", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-unity-signals-");
  const store = new AssetStore();
  const signalSkills = [
    "signal-unity-runtime-log",
    "signal-unity-callback-event-by-runtime-log",
    "signal-unity-local-storage",
  ];

  for (const agentId of ["researcher", "verifier", "validator"]) {
    const mount = store.materializeMount({
      scoutRoot: fixtureRoot,
      runId: `run-unity-signals-${agentId}-test`,
      agentId,
    });
    const manifest = JSON.parse(readFileSync(mount.manifestPath, "utf8")) as MountManifest;

    for (const signalSkill of signalSkills) {
      assert.ok(mount.skills.includes(signalSkill));
      assert.ok(manifest.skills.includes(signalSkill));
      assert.equal(existsSync(join(
        mount.mountRoot,
        ".scout",
        "skills",
        signalSkill,
        "SKILL.md",
      )), true);
    }
  }

  const coordinatorMount = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-unity-signals-coordinator-test",
    agentId: "coordinator",
  });
  for (const signalSkill of signalSkills) {
    assert.equal(coordinatorMount.skills.includes(signalSkill), false);
  }
});

test("AssetStore mounts the Unity Pipeline CLI Tool and runtime-log Acquisition by execution and audit role", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-runtime-log-acquisition-");
  const store = new AssetStore();
  const toolSkill = "tool-unity-pipeline-cli";
  const acquisitionSkill = "signal-unity-runtime-log-unity-pipeline-cli";

  const verifierMount = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-runtime-log-acquisition-verifier-test",
    agentId: "verifier",
  });
  assert.ok(verifierMount.skills.includes(toolSkill));
  assert.ok(verifierMount.skills.includes(acquisitionSkill));
  assert.ok(verifierMount.shellTools.some((tool) => tool.id === "unity"));
  assert.equal(existsSync(join(
    verifierMount.mountRoot,
    ".scout",
    "skills",
    toolSkill,
    "SKILL.md",
  )), true);
  assert.equal(existsSync(join(
    verifierMount.mountRoot,
    ".scout",
    "skills",
    acquisitionSkill,
    "SKILL.md",
  )), true);
  assert.equal(existsSync(join(verifierMount.mountRoot, "bin", "unity")), true);

  const validatorMount = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-runtime-log-acquisition-validator-test",
    agentId: "validator",
  });
  assert.ok(validatorMount.skills.includes(toolSkill));
  assert.ok(validatorMount.skills.includes(acquisitionSkill));
  assert.equal(validatorMount.shellTools.some((tool) => tool.id === "unity"), false);

  for (const agentId of ["coordinator", "researcher"]) {
    const mount = store.materializeMount({
      scoutRoot: fixtureRoot,
      runId: `run-runtime-log-acquisition-${agentId}-test`,
      agentId,
    });
    assert.equal(mount.skills.includes(toolSkill), false);
    assert.equal(mount.skills.includes(acquisitionSkill), false);
    assert.equal(mount.shellTools.some((tool) => tool.id === "unity"), false);
  }
});

test("Every Skill name and id match its directory name", () => {
  const skillsRoot = join(scoutRoot, "assets", "codex", "skills");
  const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.ok(skillNames.length > 0);

  for (const skillName of skillNames) {
    const skillPath = join(skillsRoot, skillName, "SKILL.md");
    assert.equal(existsSync(skillPath), true, `${skillName} must contain SKILL.md`);

    const text = readFileSync(skillPath, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    assert.ok(frontmatter, `${skillName} must contain YAML frontmatter`);

    const name = /^name:\s*(\S+)\s*$/m.exec(frontmatter[1])?.[1];
    const id = /^id:\s*(\S+)\s*$/m.exec(frontmatter[1])?.[1];
    assert.equal(name, skillName, `${skillName} frontmatter name must match its directory`);
    assert.equal(id, skillName, `${skillName} frontmatter id must match its directory`);
  }
});

test("AssetStore exposes Research artifact checking and git tools to the researcher", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-research-tools-");
  const mount = new AssetStore().materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-shell-tool-domain-validation-researcher-test",
    agentId: "researcher",
  });
  const checker = mount.shellTools.find((tool) => tool.id === "scoutResearchArtifactCheck");
  const digest = mount.shellTools.find((tool) => tool.id === "scoutArtifactDigest");
  const git = mount.shellTools.find((tool) => tool.id === "git");
  const wrapperPath = join(mount.mountRoot, "bin", "scout-research-artifact-check");
  const digestWrapperPath = join(mount.mountRoot, "bin", "scout-artifact-digest");

  assert.ok(checker);
  assert.ok(digest);
  assert.ok(git);
  assert.ok(mount.skills.includes("tool-guru-knowledge"));
  assert.equal(existsSync(wrapperPath), true);
  assert.equal(existsSync(digestWrapperPath), true);
  assert.match(execFileSync(wrapperPath, ["--smoke"], {
    cwd: mount.mountRoot,
    encoding: "utf8",
  }), /SCOUT_RESEARCH_ARTIFACT_CHECK_OK/);
  assert.match(execFileSync(digestWrapperPath, ["--smoke"], {
    cwd: mount.mountRoot,
    encoding: "utf8",
  }), /SCOUT_ARTIFACT_DIGEST_OK/);
});

test("AssetStore gives the validator producer contracts, code inspection tools, and a neutral digest tool", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-validator-tools-");
  const mount = new AssetStore().materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-shell-tool-validator-gate-test",
    agentId: "validator",
  });
  const digest = mount.shellTools.find((tool) => tool.id === "scoutArtifactDigest");
  const wrapperPath = join(mount.mountRoot, "bin", "scout-artifact-digest");

  assert.ok(mount.skills.includes("domain-validation-validator"));
  assert.ok(mount.skills.includes("domain-validation-research-pack"));
  assert.ok(mount.skills.includes("domain-validation-verifier"));
  assert.ok(mount.skills.includes("tool-guru-knowledge"));
  assert.ok(mount.skills.includes("tool-jarvis-codebase"));
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

test("AssetStore resolves asset-local shell tool commands against the Scout root", () => {
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
    scoutRoot: fixtureRoot,
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

test("Shell tool registry changes do not change new asset identity", () => {
  const fixtureRoot = createCodexAssetFixture("scout-shell-tool-registry-hash-");
  const assetsRoot = join(fixtureRoot, "assets", "codex");
  const firstToolPath = join(fixtureRoot, "device-tools", "first-tool");
  const secondToolPath = join(fixtureRoot, "device-tools", "second-tool");
  mkdirSync(join(fixtureRoot, "device-tools"), { recursive: true });
  writeExecutable(firstToolPath, "FIRST_TOOL_OK");
  writeExecutable(secondToolPath, "SECOND_TOOL_OK");
  writeShellTools(assetsRoot, {
    tools: [{
      id: "deviceTool",
      name: "first-device-tool",
      command: firstToolPath,
      exposeAs: "device-tool",
      required: true,
    }],
  });
  updateCoordinatorShellTools(assetsRoot, ["deviceTool"]);

  const store = new AssetStore();
  const before = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-shell-tool-registry-hash-test",
    agentId: "coordinator",
  });
  writeShellTools(assetsRoot, {
    tools: [{
      id: "deviceTool",
      name: "second-device-tool",
      command: secondToolPath,
      exposeAs: "device-tool",
      required: true,
    }],
  });
  const after = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-shell-tool-registry-hash-test",
    agentId: "coordinator",
  });

  assert.equal(after.resourceHash, before.resourceHash);
  assert.equal(after.assetCommitId, before.assetCommitId);
  assert.equal(after.mountId, before.mountId);
  assert.equal(execFileSync(join(after.mountRoot, "bin", "device-tool"), [], {
    cwd: after.mountRoot,
    encoding: "utf8",
  }).trim(), "SECOND_TOOL_OK");
});

test("AssetStore rebuilds a reused mount when a shell contract binding changes", () => {
  const fixtureRoot = createCodexAssetFixture("scout-shell-tool-reuse-binding-");
  const assetsRoot = join(fixtureRoot, "assets", "codex");
  const firstToolPath = join(fixtureRoot, "device-tools", "first-tool");
  const secondToolPath = join(fixtureRoot, "device-tools", "second-tool");
  mkdirSync(join(fixtureRoot, "device-tools"), { recursive: true });
  writeExecutable(firstToolPath, "FIRST_TOOL_OK");
  writeExecutable(secondToolPath, "SECOND_TOOL_OK");
  writeShellTools(assetsRoot, {
    tools: [{
      id: "deviceTool",
      name: "device-tool",
      command: firstToolPath,
      exposeAs: "device-tool",
      required: true,
    }],
  });
  updateCoordinatorShellTools(assetsRoot, ["deviceTool"]);
  const store = new AssetStore();
  const initial = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-shell-tool-reuse-binding",
    agentId: "coordinator",
  });

  writeShellTools(assetsRoot, {
    tools: [{
      id: "deviceTool",
      name: "device-tool",
      command: secondToolPath,
      exposeAs: "device-tool",
      required: true,
    }],
  });
  const manifest = JSON.parse(readFileSync(initial.manifestPath, "utf8")) as MountManifest;
  const prepared = store.prepareMount({
    scoutRoot: fixtureRoot,
    runId: "run-shell-tool-reuse-binding",
    agentId: "coordinator",
    cleanRunRoot: false,
    persistedManifest: manifest,
    persistedIdentity: {
      assetCommitId: initial.assetCommitId,
      parentAssetCommitId: initial.parentAssetCommitId,
      mountId: initial.mountId,
      resourceHash: initial.resourceHash,
    },
  });

  assert.equal(prepared.decision, "rebuild");
  assert.equal(execFileSync(join(prepared.mount.mountRoot, "bin", "device-tool"), [], {
    cwd: prepared.mount.mountRoot,
    encoding: "utf8",
  }).trim(), "SECOND_TOOL_OK");
});

test("Asset-local shell tool scripts remain part of the resource hash", () => {
  const fixtureRoot = createCodexAssetFixture("scout-shell-tool-script-hash-");
  const assetsRoot = join(fixtureRoot, "assets", "codex");
  const toolPath = join(assetsRoot, "tools", "asset-local-hashed-tool");
  writeExecutable(toolPath, "BEFORE_TOOL_OK");
  writeShellTools(assetsRoot, {
    tools: [{
      id: "assetLocalHashedTool",
      name: "asset-local-hashed-tool",
      command: "assets/codex/tools/asset-local-hashed-tool",
      exposeAs: "asset-local-hashed-tool",
      required: true,
    }],
  });
  updateCoordinatorShellTools(assetsRoot, ["assetLocalHashedTool"]);

  const store = new AssetStore();
  const before = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-shell-tool-script-hash-test",
    agentId: "coordinator",
  });
  writeExecutable(toolPath, "AFTER_TOOL_OK");
  const after = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-shell-tool-script-hash-test",
    agentId: "coordinator",
  });

  assert.notEqual(after.resourceHash, before.resourceHash);
  assert.notEqual(after.assetCommitId, before.assetCommitId);
  assert.notEqual(after.mountId, before.mountId);
  const manifest = JSON.parse(readFileSync(after.manifestPath, "utf8")) as MountManifest;
  assert.ok(manifest.assets.some((asset) =>
    asset.id === "codex.shell_tool.assetLocalHashedTool.command"
    && asset.type === "shell_tool_resource"
    && asset.sourcePath === "assets/codex/tools/asset-local-hashed-tool"
    && asset.hash === sha256FileForTest(toolPath)
  ));
});

test("AssetStore rematerializes current paths while preserving portable persisted identity", () => {
  const sourceRoot = createCodexAssetFixture("scout-persisted-mount-source-");
  const targetRoot = createCodexAssetFixture("scout-persisted-mount-target-");
  const runId = "run-persisted-mount-identity-test";
  const source = new AssetStore().materializeMount({
    scoutRoot: sourceRoot,
    runId,
    agentId: "coordinator",
  });
  const persistedIdentity = {
    assetCommitId: source.assetCommitId,
    parentAssetCommitId: source.parentAssetCommitId,
    mountId: source.mountId,
    resourceHash: source.resourceHash,
  };
  const target = new AssetStore().materializeMount({
    scoutRoot: targetRoot,
    runId,
    agentId: "coordinator",
    persistedIdentity: {
      assetCommitId: source.assetCommitId,
      parentAssetCommitId: source.parentAssetCommitId,
      mountId: source.mountId,
      resourceHash: source.resourceHash,
    },
  });
  const manifest = JSON.parse(readFileSync(target.manifestPath, "utf8")) as MountManifest;
  const config = readFileSync(join(target.mountRoot, ".codex", "config.toml"), "utf8");

  assert.equal(target.assetCommitId, persistedIdentity.assetCommitId);
  assert.equal(target.parentAssetCommitId, persistedIdentity.parentAssetCommitId);
  assert.equal(target.mountId, persistedIdentity.mountId);
  assert.equal(target.resourceHash, persistedIdentity.resourceHash);
  assert.equal(target.scoutRoot, targetRoot);
  assert.equal(manifest.assetCommitId, persistedIdentity.assetCommitId);
  assert.equal(manifest.parentAssetCommitId, persistedIdentity.parentAssetCommitId);
  assert.equal(manifest.mountId, persistedIdentity.mountId);
  assert.equal(manifest.resourceHash, persistedIdentity.resourceHash);
  assert.ok(target.mountRoot.startsWith(targetRoot));
  assert.ok(config.includes(targetRoot));
  assert.equal(config.includes(sourceRoot), false);
  assert.equal(
    realpathSync(join(target.mountRoot, "AGENTS.md")),
    realpathSync(join(targetRoot, "assets", "codex", "agents", "AGENTS.md")),
  );
});

test("AssetStore rebuilds a copied run once, then reuses the current mount", () => {
  const sourceRoot = createCodexAssetFixture("scout-copied-run-source-");
  const targetRoot = createCodexAssetFixture("scout-copied-run-target-");
  const runId = "run-copied-mount-reuse-test";
  const sourceStore = new AssetStore();
  const source = sourceStore.materializeMount({
    scoutRoot: sourceRoot,
    runId,
    agentId: "coordinator",
  });
  const sourceManifest = JSON.parse(readFileSync(source.manifestPath, "utf8")) as MountManifest;
  mkdirSync(join(targetRoot, "run"), { recursive: true });
  cpSync(join(sourceRoot, "run", runId), join(targetRoot, "run", runId), { recursive: true });

  const identity = {
    assetCommitId: source.assetCommitId,
    parentAssetCommitId: source.parentAssetCommitId,
    mountId: source.mountId,
    resourceHash: source.resourceHash,
  };
  const targetStore = new AssetStore();
  const relocated = targetStore.prepareMount({
    scoutRoot: targetRoot,
    runId,
    agentId: "coordinator",
    cleanRunRoot: false,
    persistedManifest: sourceManifest,
    persistedIdentity: identity,
  });
  assert.equal(relocated.decision, "rebuild");
  assert.equal(relocated.mount.scoutRoot, targetRoot);
  assert.equal(relocated.mount.assetCommitId, identity.assetCommitId);
  assert.equal(relocated.mount.mountId, identity.mountId);
  const relocatedConfig = readFileSync(join(relocated.mount.mountRoot, ".codex", "config.toml"), "utf8");
  assert.ok(relocatedConfig.includes(targetRoot));
  assert.equal(relocatedConfig.includes(sourceRoot), false);

  const currentManifest = JSON.parse(readFileSync(relocated.mount.manifestPath, "utf8")) as MountManifest;
  const reused = targetStore.prepareMount({
    scoutRoot: targetRoot,
    runId,
    agentId: "coordinator",
    cleanRunRoot: false,
    persistedManifest: currentManifest,
    persistedIdentity: {
      ...identity,
      resourceHash: relocated.mount.resourceHash,
    },
  });
  assert.equal(reused.decision, "reused");
  assert.equal(reused.mount.scoutRoot, targetRoot);
  assert.equal(reused.mount.mountRoot, relocated.mount.mountRoot);
});

test("AssetStore resolves asset-local MCP commands against the Scout root", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-mcp-command-");
  const assetsRoot = join(fixtureRoot, "assets", "codex");
  const commandPath = join(assetsRoot, "tools", "asset-local-mcp");
  const vendorPath = join(assetsRoot, "tools", "vendor", "dependency.cjs");
  mkdirSync(join(assetsRoot, "tools", "vendor"), { recursive: true });
  writeFileSync(vendorPath, "module.exports = 'before';\n", "utf8");
  writeExecutable(commandPath, "ASSET_LOCAL_MCP_OK");
  writeMcpServers(assetsRoot, {
    servers: {
      assetLocal: {
        command: "assets/codex/tools/asset-local-mcp",
      },
    },
  });
  updateCoordinatorMcpServers(assetsRoot, ["assetLocal"]);

  const store = new AssetStore();
  const mount = store.materializeMount({
    scoutRoot: fixtureRoot,
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
  const manifest = JSON.parse(readFileSync(mount.manifestPath, "utf8")) as MountManifest;
  assert.ok(manifest.assets.some((asset) =>
    asset.id === "codex.mcp_server.assetLocal.command"
    && asset.type === "mcp_server_resource"
    && asset.sourcePath === "assets/codex/tools/asset-local-mcp"
    && asset.hash === sha256FileForTest(commandPath)
  ));
  assert.ok(manifest.assets.some((asset) =>
    asset.id === "codex.mcp_server.assetLocal.command.vendor"
    && asset.type === "mcp_server_vendor"
    && asset.sourcePath === "assets/codex/tools/vendor"
  ));

  writeExecutable(commandPath, "ASSET_LOCAL_MCP_CHANGED");
  assert.throws(() => store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-asset-local-mcp-command-test",
    agentId: "coordinator",
    cleanRunRoot: false,
    persistedIdentity: {
      assetCommitId: mount.assetCommitId,
      parentAssetCommitId: mount.parentAssetCommitId,
      mountId: mount.mountId,
      resourceHash: mount.resourceHash,
    },
  }), /Persisted resource identity does not match current assets for coordinator/);
  const changed = store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-asset-local-mcp-command-changed-test",
    agentId: "coordinator",
  });
  assert.notEqual(changed.resourceHash, mount.resourceHash);

  writeFileSync(vendorPath, "module.exports = 'after';\n", "utf8");
  assert.throws(() => store.materializeMount({
    scoutRoot: fixtureRoot,
    runId: "run-asset-local-mcp-command-changed-test",
    agentId: "coordinator",
    cleanRunRoot: false,
    persistedIdentity: {
      assetCommitId: changed.assetCommitId,
      parentAssetCommitId: changed.parentAssetCommitId,
      mountId: changed.mountId,
      resourceHash: changed.resourceHash,
    },
  }), /Persisted resource identity does not match current assets for coordinator/);
});

test("Asset-local shell and MCP references fail closed when missing", () => {
  const shellFixtureRoot = createCodexAssetFixture("scout-missing-shell-resource-");
  const shellAssetsRoot = join(shellFixtureRoot, "assets", "codex");
  writeShellTools(shellAssetsRoot, {
    tools: [{
      id: "missingAssetTool",
      name: "missing-asset-tool",
      command: "assets/codex/tools/missing-asset-tool",
      exposeAs: "missing-asset-tool",
      required: true,
    }],
  });
  updateCoordinatorShellTools(shellAssetsRoot, ["missingAssetTool"]);
  assert.throws(() => new AssetStore().materializeMount({
    scoutRoot: shellFixtureRoot,
    runId: "run-missing-shell-resource",
    agentId: "coordinator",
  }), /Asset-local resource is missing: assets\/codex\/tools\/missing-asset-tool/);

  const mcpFixtureRoot = createCodexAssetFixture("scout-missing-mcp-resource-");
  const mcpAssetsRoot = join(mcpFixtureRoot, "assets", "codex");
  writeMcpServers(mcpAssetsRoot, {
    servers: {
      missingAsset: {
        command: "node",
        args: ["assets/codex/mcp/missing-server.cjs"],
      },
    },
  });
  updateCoordinatorMcpServers(mcpAssetsRoot, ["missingAsset"]);
  assert.throws(() => new AssetStore().materializeMount({
    scoutRoot: mcpFixtureRoot,
    runId: "run-missing-mcp-resource",
    agentId: "coordinator",
  }), /Asset-local resource is missing: assets\/codex\/mcp\/missing-server\.cjs/);
});

test("scout-memory reports run-level codex memory files without reading sqlite content", () => {
  const fixtureRoot = createCodexAssetFixture("scout-asset-store-shell-tools-");
  const runId = "run-shell-tool-memory-test";
  const mount = new AssetStore().materializeMount({
    scoutRoot: fixtureRoot,
    runId,
    agentId: "coordinator",
  });
  const codexHome = join(fixtureRoot, "run", runId, "codex-home", ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "memories_1.sqlite"), "memory-db-placeholder", "utf8");
  writeFileSync(join(codexHome, "state_5.sqlite-wal"), "state-wal-placeholder", "utf8");
  writeFileSync(join(codexHome, "ignored.txt"), "not memory", "utf8");

  const scriptPath = join(scoutRoot, "assets", "codex", "tools", "scout-memory.cjs");
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

function sha256FileForTest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function mountIdentity(mount: CodexMount) {
  return {
    assetCommitId: mount.assetCommitId,
    parentAssetCommitId: mount.parentAssetCommitId,
    mountId: mount.mountId,
    resourceHash: mount.resourceHash,
  };
}

function writeManifest(path: string, manifest: MountManifest): void {
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

function reverseObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseObjectKeys) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  ) as T;
}

function createCodexAssetFixture(prefix: string): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(scoutRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
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
