import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { buildCodexAppServerClientConfig } from "../../src/agent-server/codex/app-server-factory.js";

test("app-server factory config trusts all prepared agent mount roots", () => {
  const repoRoot = "/tmp/scout-app-server-factory";
  const coordinatorMount = join(repoRoot, "run", "run-a", "agents", "coordinator", "mount");
  const researcherMount = join(repoRoot, "run", "run-a", "agents", "researcher", "mount");
  const guruKnowledge = "/Users/chengdai/.guru/knowledge";
  const guruCodebase = "/Users/chengdai/.guru/codebase";

  const config = buildCodexAppServerClientConfig({
    mountRoots: [
      coordinatorMount,
      researcherMount,
      coordinatorMount,
    ],
    trustedRoots: [
      repoRoot,
      guruKnowledge,
      researcherMount,
    ],
    writableRoots: [
      guruCodebase,
      join(repoRoot, "run", "run-a", "agents", "researcher", "artifacts"),
    ],
  });

  assert.deepEqual(config.mountRoots, [
    resolve(coordinatorMount),
    resolve(researcherMount),
  ]);
  assert.ok(config.trustedRoots.includes(resolve(repoRoot)));
  assert.ok(config.trustedRoots.includes(resolve(guruKnowledge)));
  assert.ok(config.defaultWritableRoots.includes(resolve(coordinatorMount)));
  assert.ok(config.defaultWritableRoots.includes(resolve(researcherMount)));
  assert.ok(config.defaultWritableRoots.includes(resolve(coordinatorMount, "..", "artifacts")));
  assert.ok(config.defaultWritableRoots.includes(resolve(researcherMount, "..", "artifacts")));
  assert.ok(config.defaultWritableRoots.includes(resolve(guruCodebase)));
  assert.match(config.configToml, new RegExp(escapeRegExp(`[projects."${resolve(coordinatorMount)}"]`)));
  assert.match(config.configToml, new RegExp(escapeRegExp(`[projects."${resolve(researcherMount)}"]`)));
  assert.match(config.configToml, new RegExp(escapeRegExp(`[projects."${resolve(repoRoot)}"]`)));
  assert.match(config.configToml, new RegExp(escapeRegExp(`[projects."${resolve(guruKnowledge)}"]`)));
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
