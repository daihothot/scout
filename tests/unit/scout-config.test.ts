import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadScoutConfig, scoutConfigPath } from "../../src/system/config/index.js";
import { AssetStore } from "../../src/asset-store/index.js";

test("AssetStore config selects its reader by suffix and returns parsed structures", () => {
  const scoutRoot = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "scout-config-reader-"));
  const configRoot = join(scoutRoot, "assets", "scout", "config");
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(configRoot, "sample.config.json"), JSON.stringify({
    feature: { enabled: true },
  }), "utf8");

  try {
    const config = new AssetStore().config(scoutRoot);
    assert.deepEqual(config.read("sample.config.json"), {
      feature: { enabled: true },
    });
    assert.throws(
      () => config.read("../outside.json"),
      /escapes assets root/,
    );
    assert.throws(
      () => config.read("sample.config.yaml"),
      /Unsupported Asset config file suffix.*\.yaml/,
    );
  } finally {
    rmSync(scoutRoot, { recursive: true, force: true });
  }
});

test("AssetStore config owns format parsing failures", () => {
  const scoutRoot = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "scout-config-format-"));
  const configRoot = join(scoutRoot, "assets", "scout", "config");
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(configRoot, "invalid.config.json"), "{", "utf8");

  try {
    const config = new AssetStore().config(scoutRoot);
    assert.throws(
      () => config.read("invalid.config.json"),
      /Cannot load Asset config invalid\.config\.json: Invalid Asset JSON/,
    );
  } finally {
    rmSync(scoutRoot, { recursive: true, force: true });
  }
});

test("loadScoutConfig reads the Workflow Profile and restore policy", () => {
  const scoutRoot = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "scout-config-"));
  const path = scoutConfigPath(scoutRoot);
  mkdirSync(join(scoutRoot, "assets", "scout", "config"), { recursive: true });
  writeFileSync(path, JSON.stringify({
    workflow: { profile: "validation" },
    restore: { allowAssetResourceDrift: true },
  }), "utf8");

  try {
    assert.deepEqual(loadScoutConfig(new AssetStore().config(scoutRoot)), {
      workflow: { profile: "validation" },
      restore: { allowAssetResourceDrift: true },
    });
  } finally {
    rmSync(scoutRoot, { recursive: true, force: true });
  }
});

test("loadScoutConfig rejects unknown or malformed fields", () => {
  const scoutRoot = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "scout-config-invalid-"));
  const path = scoutConfigPath(scoutRoot);
  mkdirSync(join(scoutRoot, "assets", "scout", "config"), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify({
      workflow: { profile: "validation" },
      restore: { allowAssetResourceDrift: "yes" },
    }), "utf8");
    assert.throws(
      () => loadScoutConfig(new AssetStore().config(scoutRoot)),
      /must be a boolean/,
    );

    writeFileSync(path, JSON.stringify({
      workflow: { profile: "validation" },
      restore: {},
    }), "utf8");
    assert.throws(
      () => loadScoutConfig(new AssetStore().config(scoutRoot)),
      /restore\.allowAssetResourceDrift must be a boolean/,
    );

    writeFileSync(path, JSON.stringify({
      workflow: { profile: "validation" },
      restore: { allowAssetResourceDrift: false },
      runtime: {},
    }), "utf8");
    assert.throws(
      () => loadScoutConfig(new AssetStore().config(scoutRoot)),
      /unknown top-level field/,
    );

    writeFileSync(path, JSON.stringify({
      workflow: { profile: "" },
      restore: { allowAssetResourceDrift: false },
    }), "utf8");
    assert.throws(
      () => loadScoutConfig(new AssetStore().config(scoutRoot)),
      /workflow.profile must be a string/,
    );
  } finally {
    rmSync(scoutRoot, { recursive: true, force: true });
  }
});
