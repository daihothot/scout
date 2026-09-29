import test from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import {
  createMountMacroValues,
  buildMountShellEnvironment,
  buildMountShellPath,
  resolveMountMacros,
  MountMacros,
} from "../../src/asset-store/mount/macros.js";
import { generateCodexConfig } from "../../src/asset-store/builders/codex-config-builder.js";

test("mount macros build a single canonical value map", () => {
  const values = createMountMacroValues({
    scoutRoot: "/repo",
    runRoot: "/repo/run/run-1",
    mountRoot: "/repo/run/run-1/agents/verifier/mount",
    assetCommitId: "ac_1",
  });

  assert.equal(values[MountMacros.ScoutRoot], "/repo");
  assert.equal(values[MountMacros.RunRoot], "/repo/run/run-1");
  assert.equal(values[MountMacros.MountRoot], "/repo/run/run-1/agents/verifier/mount");
  assert.equal(Object.hasOwn(values, "SCOUT_ARTIFACT_ROOT"), false);
  assert.equal(Object.hasOwn(values, "SCOUT_TEMP_ROOT"), false);
  assert.equal(values[MountMacros.AssetCommitId], "ac_1");
  assert.equal(values[MountMacros.RunId], "run-1");
});

test("mount macros resolve placeholders and drop unknown placeholders to empty string", () => {
  const values = createMountMacroValues({
    scoutRoot: "/repo",
    runRoot: "/repo/run/run-1",
    mountRoot: "/repo/run/run-1/agents/researcher/mount",
    assetCommitId: "ac_2",
  });

  assert.equal(
    resolveMountMacros("${SCOUT_MOUNT_ROOT}:${SCOUT_ARTIFACT_ROOT}:${missing.value}", values),
    "/repo/run/run-1/agents/researcher/mount::",
  );
});

test("mount shell environment exposes only shell-facing macros", () => {
  assert.deepEqual(buildMountShellEnvironment({
    runRoot: "/repo/run/run-1",
    hostTempRoot: "/host/tmp",
    assetCommitId: "ac_3",
  }), {
    SCOUT_RUN_ID: "run-1",
    SCOUT_RUN_ROOT: "/repo/run/run-1",
    SCOUT_ASSET_COMMIT_ID: "ac_3",
    TMPDIR: "/host/tmp",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.excludesFile",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  });
});

test("generated Codex config exposes the shared run root", () => {
  const config = generateCodexConfig({
    baseConfig: 'approval_policy = "never"',
    mountRoot: "/repo/run/run-1/agents/validator/mount",
    runRoot: "/repo/run/run-1",
    hostTempRoot: "/host/tmp",
    runId: "run-1",
    assetCommitId: "ac_3",
    mcpServers: [],
  });

  assert.match(config, /SCOUT_RUN_ROOT = "\/repo\/run\/run-1"/);
  assert.doesNotMatch(config, /SCOUT_(ARTIFACT|TEMP)_ROOT/);
  assert.match(config, /TMPDIR = "\/host\/tmp"/);
  assert.ok(config.includes(buildMountShellPath("/repo/run/run-1/agents/validator/mount")));
});

test("mount shell path includes the mount bin and current Node runtime", () => {
  const path = buildMountShellPath("/repo/run/run-1/agents/validator/mount");
  assert.equal(path.split(":")[0], "/repo/run/run-1/agents/validator/mount/bin");
  assert.ok(path.split(":").includes(dirname(process.execPath)));
});
