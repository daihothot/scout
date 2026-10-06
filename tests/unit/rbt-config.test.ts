import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssetStore } from "../../src/asset-store/index.js";
import { loadRbtConfig } from "../../src/domain/domains/rbt/index.js";

test("loadRbtConfig reads isolated platform-keyed physical execution sources", () => {
  const scoutRoot = mkdtempSync(join(tmpdir(), "scout-rbt-config-"));
  const configRoot = join(scoutRoot, "assets", "scout", "config");
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(configRoot, "rbt.config.json"), JSON.stringify({
    executionSources: {
      unity_editor: { transport: "unity-pipeline" },
      android: { transport: "adb", appId: "com.example.app", artifactPath: "/tmp/example.apk" },
    },
  }), "utf8");

  try {
    assert.deepEqual(loadRbtConfig(new AssetStore().config(scoutRoot)), {
      executionSources: {
        unity_editor: { transport: "unity-pipeline" },
        android: { transport: "adb", appId: "com.example.app", artifactPath: "/tmp/example.apk" },
      },
    });
  } finally {
    rmSync(scoutRoot, { recursive: true, force: true });
  }
});

test("loadRbtConfig allows discovery defaults and platform-specific fields to be absent", () => {
  const scoutRoot = mkdtempSync(join(tmpdir(), "scout-rbt-config-invalid-"));
  const configRoot = join(scoutRoot, "assets", "scout", "config");
  const configPath = join(configRoot, "rbt.config.json");
  mkdirSync(configRoot, { recursive: true });

  try {
    writeFileSync(configPath, JSON.stringify({ executionSources: {} }), "utf8");
    assert.deepEqual(loadRbtConfig(new AssetStore().config(scoutRoot)), {
      executionSources: {},
    });

    writeFileSync(configPath, JSON.stringify({
      executionSources: { unity_editor: { transport: "unity-pipeline" } },
    }), "utf8");
    assert.deepEqual(loadRbtConfig(new AssetStore().config(scoutRoot)), {
      executionSources: { unity_editor: { transport: "unity-pipeline" } },
    });
  } finally {
    rmSync(scoutRoot, { recursive: true, force: true });
  }
});

test("loadRbtConfig rejects malformed or unknown provided fields", () => {
  const scoutRoot = mkdtempSync(join(tmpdir(), "scout-rbt-config-invalid-"));
  const configRoot = join(scoutRoot, "assets", "scout", "config");
  const configPath = join(configRoot, "rbt.config.json");
  mkdirSync(configRoot, { recursive: true });

  try {
    for (const value of [
      {}, { execution: {} }, { executionSources: [] },
      { executionSources: { windows: {} } },
      { executionSources: { android: { platform: "android" } } },
      { executionSources: { android: null } },
    ]) {
      writeFileSync(configPath, JSON.stringify(value), "utf8");
      assert.throws(() => loadRbtConfig(new AssetStore().config(scoutRoot)), /Invalid RBT config/);
    }
    writeFileSync(configPath, JSON.stringify({
      executionSources: { android: {
        transport: "adb", appId: "com.example.app", artifactPath: "/tmp/example.apk", targetId: "device-1",
      } },
    }), "utf8");
    assert.throws(
      () => loadRbtConfig(new AssetStore().config(scoutRoot)),
      /unknown executionSources.android field.*targetId/,
    );

    writeFileSync(configPath, JSON.stringify({
      executionSources: { android: { appId: 42 } },
    }), "utf8");
    assert.throws(
      () => loadRbtConfig(new AssetStore().config(scoutRoot)),
      /executionSources\.android\.appId must be a string/,
    );
  } finally {
    rmSync(scoutRoot, { recursive: true, force: true });
  }
});
