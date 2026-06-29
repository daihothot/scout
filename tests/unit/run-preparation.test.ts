import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareRuntimeRun, RuntimeRunAgentRoles } from "../../src/runtime/run/index.js";
import {
  buildCodexAppServerClientConfig,
  type CreateCodexAppServerClientOptions,
} from "../../src/agent-server/codex/app-server-factory.js";
import type { AgentServerPreflightResult } from "../../src/agent-server/types.js";
import type { CodexMount } from "../../src/asset-store/index.js";
import { ScoutAgentRoles } from "../../src/agent/types.js";

const repoRoot = process.cwd();

test("prepareRuntimeRun materializes all agent mounts and wires one app-server session root set", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-run-preparation-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });

  const clientCalls: CreateCodexAppServerClientOptions[] = [];
  const preflightedAgents: string[] = [];
  const runId = "run-root-aggregation-test";

  const prepared = await prepareRuntimeRun({
    repoRoot: fixtureRoot,
    runId,
    preflightMount: async (mount: CodexMount): Promise<AgentServerPreflightResult> => {
      preflightedAgents.push(mount.agentId);
      return {
        status: "passed",
        isolatedHome: join(fixtureRoot, ".preflight-home", mount.agentId),
        isolatedCodexHome: join(fixtureRoot, ".preflight-home", mount.agentId, ".codex"),
      };
    },
    createAppServerClient: (options) => {
      clientCalls.push(options);
      return {
        kind: "fake-client",
        config: buildCodexAppServerClientConfig({
          mountRoots: options.mountRoots,
          trustedRoots: options.trustedRoots,
          writableRoots: options.writableRoots ?? [],
        }),
      };
    },
  });

  assert.equal(clientCalls.length, 1);
  assert.deepEqual(preflightedAgents.sort(), [...RuntimeRunAgentRoles].sort());
  assert.deepEqual(Object.keys(prepared.agents).sort(), [...RuntimeRunAgentRoles].sort());
  assert.deepEqual(clientCalls[0]?.mountRoots.sort(), prepared.rootAccess.mountRoots.sort());
  assert.deepEqual(clientCalls[0]?.trustedRoots?.sort(), prepared.rootAccess.trustedRoots.sort());
  assert.deepEqual(clientCalls[0]?.writableRoots?.sort(), prepared.rootAccess.writableRoots.sort());

  for (const role of RuntimeRunAgentRoles) {
    const agent = prepared.agents[role];
    assert.equal(agent.mount.mountRoot, join(fixtureRoot, "run", runId, "agents", role, "mount"));
    assert.ok(existsSync(agent.preflightPath));
    assert.ok(existsSync(agent.assetCommitPath));
    const expectedStatus = agent.mount.issues.some((issue) => issue.severity === "error")
      ? "preflight_failed"
      : "preflight_passed";
    assert.equal(agent.assetCommit.status, expectedStatus);
    assert.equal(agent.assetCommit.preflightRef, agent.preflightPath);
    assert.equal(JSON.parse(readFileSync(agent.preflightPath, "utf8")).status, "passed");
    assert.equal(JSON.parse(readFileSync(agent.assetCommitPath, "utf8")).assetCommitId, agent.mount.assetCommitId);
  }
  assert.ok(Object.values(prepared.agents).every((agent) => agent.assetCommit.status === "preflight_passed"));

  const expectedMountRoots = RuntimeRunAgentRoles.map((role) =>
    resolve(fixtureRoot, "run", runId, "agents", role, "mount")
  ).sort();
  assert.deepEqual(prepared.rootAccess.mountRoots, expectedMountRoots);
  assert.ok(prepared.rootAccess.trustedRoots.includes(resolve(fixtureRoot)));
  assert.ok(prepared.rootAccess.trustedRoots.includes(resolve(homedir(), ".guru", "knowledge")));
  assert.ok(prepared.rootAccess.writableRoots.includes(resolve(homedir(), ".guru", "codebase")));
  assert.ok(prepared.rootAccess.writableRoots.includes(resolve(fixtureRoot, "run", runId, "agents", ScoutAgentRoles.Coordinator, "artifacts")));
  assert.match(prepared.appServerClient.config.configToml, new RegExp(escapeRegExp(`[projects."${expectedMountRoots[0]}"]`)));
  assert.match(prepared.appServerClient.config.configToml, new RegExp(escapeRegExp(`[projects."${resolve(fixtureRoot)}"]`)));
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
