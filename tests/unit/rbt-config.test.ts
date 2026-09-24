import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssetStore } from "../../src/asset-store/index.js";
import { loadRbtConfig } from "../../src/domain/rbt/index.js";

test("loadRbtConfig reads the physical execution target", () => {
  const scoutRoot = mkdtempSync(join(tmpdir(), "scout-rbt-config-"));
  const configRoot = join(scoutRoot, "assets", "scout", "config");
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(configRoot, "rbt.config.json"), JSON.stringify({
    execution: {
      transport: "adb",
      platform: "android",
      appId: "com.example.app",
      artifactPath: "/tmp/example.apk",
    },
  }), "utf8");

  try {
    assert.deepEqual(loadRbtConfig(new AssetStore().config(scoutRoot)), {
      execution: {
        transport: "adb",
        platform: "android",
        appId: "com.example.app",
        artifactPath: "/tmp/example.apk",
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
    writeFileSync(configPath, JSON.stringify({}), "utf8");
    assert.deepEqual(loadRbtConfig(new AssetStore().config(scoutRoot)), {
      execution: {},
    });

    writeFileSync(configPath, JSON.stringify({
      execution: {
        transport: "unity-pipeline",
        platform: "unity_editor",
      },
    }), "utf8");
    assert.deepEqual(loadRbtConfig(new AssetStore().config(scoutRoot)), {
      execution: {
        transport: "unity-pipeline",
        platform: "unity_editor",
      },
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
    writeFileSync(configPath, JSON.stringify({
      execution: {
        transport: "adb",
        platform: "android",
        appId: "com.example.app",
        artifactPath: "/tmp/example.apk",
        targetId: "device-1",
      },
    }), "utf8");
    assert.throws(
      () => loadRbtConfig(new AssetStore().config(scoutRoot)),
      /unknown execution field.*targetId/,
    );

    writeFileSync(configPath, JSON.stringify({
      execution: { appId: 42 },
    }), "utf8");
    assert.throws(
      () => loadRbtConfig(new AssetStore().config(scoutRoot)),
      /execution\.appId must be a string/,
    );
  } finally {
    rmSync(scoutRoot, { recursive: true, force: true });
  }
});
