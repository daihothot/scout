import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const digestTool = join(repoRoot, "assets", "codex", "tools", "scout-artifact-digest.cjs");

test("scout-artifact-digest produces a location-independent directory digest", () => {
  const first = createPack("scout-artifact-digest-first-");
  const second = createPack("scout-artifact-digest-second-");

  assert.equal(readDigest(first), readDigest(second));
});

test("scout-artifact-digest changes when artifact content changes", () => {
  const pack = createPack("scout-artifact-digest-change-");
  const before = readDigest(pack);
  writeFileSync(join(pack, "evidence", "E-KB-001.md"), "changed\n", "utf8");

  assert.notEqual(readDigest(pack), before);
});

test("scout-artifact-digest rejects symbolic links", () => {
  const pack = createPack("scout-artifact-digest-link-");
  symlinkSync(join(pack, "index.md"), join(pack, "linked-index.md"));

  const result = spawnSync(process.execPath, [digestTool, pack], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /artifact_digest_valid=false/);
  assert.match(result.stderr, /Symbolic links are not accepted/);
});

function createPack(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "evidence"), { recursive: true });
  writeFileSync(join(root, "evidence", "E-KB-001.md"), "knowledge\n", "utf8");
  writeFileSync(join(root, "index.md"), "index\n", "utf8");
  return root;
}

function readDigest(target: string): string {
  const output = execFileSync(process.execPath, [digestTool, target], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return output.match(/^digest=(sha256:[a-f0-9]{64})$/m)?.[1] ?? "";
}
