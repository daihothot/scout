import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareRunClients } from "../../src/run/index.js";
import type { CodexAppServerClientBundle } from "../../src/agent-server/codex/app-server-factory.js";

const repoRoot = process.cwd();

test("prepareRunClients builds isolated app-server config and starts the shared session", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-run-client-preparation-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });

  const runId = "run-client-prep-test";
  let sessionStarted = false;
  const clientOptions: Array<{
    isolatedHome: string;
    isolatedCodexHome: string;
    configToml: string;
    rootPlan: unknown;
    mountRoots?: string[];
    trustedRoots?: string[];
    defaultWritableRoots?: string[];
  }> = [];

  const prepared = await prepareRunClients({
    repoRoot: fixtureRoot,
    runId,
    createAppServerClient: (options) => {
      clientOptions.push(options);
      return {
        client: {
          startSession: async () => {
            sessionStarted = true;
          },
          close: () => undefined,
        },
        isolatedHome: options.isolatedHome,
        isolatedCodexHome: options.isolatedCodexHome,
        defaultWritableRoots: options.defaultWritableRoots ?? [],
        mountRoots: options.mountRoots ?? [],
        trustedRoots: options.trustedRoots ?? [],
      } as CodexAppServerClientBundle;
    },
  });

  assert.equal(sessionStarted, true);
  assert.equal(clientOptions.length, 1);
  assert.equal(clientOptions[0]?.rootPlan, prepared.rootPlan);
  assert.deepEqual(clientOptions[0]?.mountRoots, prepared.rootPlan.mountRoots);
  assert.deepEqual(clientOptions[0]?.trustedRoots, prepared.rootPlan.trustedRoots);
  assert.deepEqual(clientOptions[0]?.defaultWritableRoots, prepared.rootPlan.defaultWritableRoots);

  const expectedHome = resolve(fixtureRoot, "run", runId, "codex-home");
  const expectedCodexHome = resolve(expectedHome, ".codex");
  assert.equal(prepared.appServerClient.isolatedHome, expectedHome);
  assert.equal(prepared.appServerClient.isolatedCodexHome, expectedCodexHome);
  assert.equal(clientOptions[0]?.isolatedHome, expectedHome);
  assert.equal(clientOptions[0]?.isolatedCodexHome, expectedCodexHome);
  assert.equal(existsSync(expectedCodexHome), true);

  const coordinatorMount = resolve(fixtureRoot, "run", runId, "agents", "coordinator", "mount");
  const verifierMount = resolve(fixtureRoot, "run", runId, "agents", "verifier", "mount");
  assert.ok(prepared.rootPlan.mountRoots.includes(coordinatorMount));
  assert.ok(prepared.rootPlan.mountRoots.includes(verifierMount));
  assert.ok(prepared.rootPlan.trustedRoots.includes(resolve(fixtureRoot)));
  assert.ok(prepared.rootPlan.trustedRoots.includes(resolve(homedir(), ".guru", "knowledge")));
  assert.ok(prepared.rootPlan.defaultWritableRoots.includes(resolve(homedir(), ".guru", "codebase")));
  assert.match(clientOptions[0]?.configToml ?? "", new RegExp(escapeRegExp(`[projects."${coordinatorMount}"]`)));
  assert.match(clientOptions[0]?.configToml ?? "", new RegExp(escapeRegExp(`[projects."${resolve(fixtureRoot)}"]`)));
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
