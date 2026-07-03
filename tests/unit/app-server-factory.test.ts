import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { buildRunClientConfig } from "../../src/run/run-client-preparation.js";

test("run client preparation config trusts all prepared agent mount roots", () => {
  const repoRoot = "/tmp/scout-app-server-factory";
  const coordinatorMount = join(repoRoot, "run", "run-a", "agents", "coordinator", "mount");
  const researcherMount = join(repoRoot, "run", "run-a", "agents", "researcher", "mount");
  const guruKnowledge = "/Users/chengdai/.guru/knowledge";

  const configToml = buildRunClientConfig({
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
  });

  assert.match(configToml, new RegExp(escapeRegExp(`[projects."${resolve(coordinatorMount)}"]`)));
  assert.match(configToml, new RegExp(escapeRegExp(`[projects."${resolve(researcherMount)}"]`)));
  assert.match(configToml, new RegExp(escapeRegExp(`[projects."${resolve(repoRoot)}"]`)));
  assert.match(configToml, new RegExp(escapeRegExp(`[projects."${resolve(guruKnowledge)}"]`)));
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
