import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMountMacroValues,
  buildMountShellEnvironment,
  resolveMountMacros,
  MountMacros,
} from "../../src/asset-store/mount-macros.js";

test("mount macros build a single canonical value map", () => {
  const values = buildMountMacroValues({
    repoRoot: "/repo",
    runRoot: "/repo/run/run-1",
    mountRoot: "/repo/run/run-1/agents/verifier/mount",
    artifactRoot: "/repo/run/run-1/agents/verifier/artifacts",
    assetCommitId: "ac_1",
  });

  assert.equal(values[MountMacros.RepoRoot], "/repo");
  assert.equal(values[MountMacros.RunRoot], "/repo/run/run-1");
  assert.equal(values[MountMacros.MountRoot], "/repo/run/run-1/agents/verifier/mount");
  assert.equal(values[MountMacros.ArtifactRoot], "/repo/run/run-1/agents/verifier/artifacts");
  assert.equal(values[MountMacros.AssetCommitId], "ac_1");
  assert.equal(values[MountMacros.RunId], "run-1");
});

test("mount macros resolve placeholders and drop unknown placeholders to empty string", () => {
  const values = buildMountMacroValues({
    repoRoot: "/repo",
    runRoot: "/repo/run/run-1",
    mountRoot: "/repo/run/run-1/agents/researcher/mount",
    artifactRoot: "/repo/run/run-1/agents/researcher/artifacts",
    assetCommitId: "ac_2",
  });

  assert.equal(
    resolveMountMacros("${SCOUT_MOUNT_ROOT}:${SCOUT_ARTIFACT_ROOT}:${missing.value}", values),
    "/repo/run/run-1/agents/researcher/mount:/repo/run/run-1/agents/researcher/artifacts:",
  );
});

test("mount shell environment exposes only shell-facing macros", () => {
  assert.deepEqual(buildMountShellEnvironment({
    runRoot: "/repo/run/run-1",
    artifactRoot: "/repo/run/run-1/agents/validator/artifacts",
    assetCommitId: "ac_3",
  }), {
    SCOUT_RUN_ID: "run-1",
    SCOUT_ARTIFACT_ROOT: "/repo/run/run-1/agents/validator/artifacts",
    SCOUT_ASSET_COMMIT_ID: "ac_3",
  });
});
