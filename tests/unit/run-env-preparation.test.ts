import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareRunEnvironment, RunAgentRoles } from "../../src/run/index.js";
import type { AgentServerPreflightResult } from "../../src/agent-server/types.js";
import type { CodexMount } from "../../src/asset-store/index.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";
import type { PreparedRunClients } from "../../src/run/run-client-preparation.js";

const repoRoot = process.cwd();

test("prepareRunEnvironment materializes all agent mounts and preflights them with prepared clients", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-run-env-preparation-"));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });

  const preflightedAgents: string[] = [];
  const runId = "run-root-aggregation-test";
  const preparedClients = createPreparedClients();

  const prepared = await prepareRunEnvironment({
    repoRoot: fixtureRoot,
    runId,
    preparedClients,
    preflightMount: async (input: {
      mount: CodexMount;
      preparedClients: PreparedRunClients;
    }): Promise<AgentServerPreflightResult> => {
      const { mount } = input;
      assert.equal(input.preparedClients, preparedClients);
      preflightedAgents.push(mount.agentId);
      return {
        status: "passed",
      };
    },
  });

  assert.deepEqual(preflightedAgents.sort(), [...RunAgentRoles].sort());
  assert.deepEqual(Object.keys(prepared.agents).sort(), [...RunAgentRoles].sort());

  for (const role of RunAgentRoles) {
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

  const expectedMountRoots = RunAgentRoles.map((role) =>
    resolve(fixtureRoot, "run", runId, "agents", role, "mount")
  ).sort();
  assert.deepEqual(prepared.rootAccess.mountRoots, expectedMountRoots);
  assert.ok(prepared.rootAccess.trustedRoots.includes(resolve(fixtureRoot)));
  assert.ok(prepared.rootAccess.trustedRoots.includes(resolve(homedir(), ".guru", "knowledge")));
  assert.ok(prepared.rootAccess.writableRoots.includes(resolve(homedir(), ".guru", "codebase")));
  assert.ok(prepared.rootAccess.writableRoots.includes(resolve(fixtureRoot, "run", runId, "agents", ScoutAgentRoles.Coordinator, "artifacts")));
});

function createPreparedClients(): PreparedRunClients {
  return {
    rootPlan: {
      mountRoots: [],
      trustedRoots: [],
      writableRoots: [],
      defaultWritableRoots: [],
    },
    appServerClient: {
      client: {} as PreparedRunClients["appServerClient"]["client"],
      isolatedHome: "/tmp/scout-test-home",
      isolatedCodexHome: "/tmp/scout-test-home/.codex",
      defaultWritableRoots: [],
      mountRoots: [],
      trustedRoots: [],
    },
  };
}
