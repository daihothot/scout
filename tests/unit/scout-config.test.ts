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

test("loadScoutConfig reads the global restore policy", () => {
  const scoutRoot = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "scout-config-"));
  const path = scoutConfigPath(scoutRoot);
  mkdirSync(join(scoutRoot, "assets", "scout", "config"), { recursive: true });
  writeFileSync(path, JSON.stringify({
    restore: { allowAssetResourceDrift: true },
  }), "utf8");

  try {
    assert.deepEqual(loadScoutConfig(scoutRoot), {
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
      restore: { allowAssetResourceDrift: "yes" },
    }), "utf8");
    assert.throws(() => loadScoutConfig(scoutRoot), /must be a boolean/);

    writeFileSync(path, JSON.stringify({
      restore: { allowAssetResourceDrift: false },
      runtime: {},
    }), "utf8");
    assert.throws(() => loadScoutConfig(scoutRoot), /unknown top-level field/);
  } finally {
    rmSync(scoutRoot, { recursive: true, force: true });
  }
});
