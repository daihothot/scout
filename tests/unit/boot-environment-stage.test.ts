import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import type { Logger } from "../../src/core/logging/index.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/protocol/port.js";
import { BootEnvironmentStage } from "../../src/run/boot/index.js";
import {
  installRunScope,
  RunScope,
} from "../../src/run/run-scope.js";

const repoRoot = process.cwd();

test("BootEnvironmentStage materializes, preflights, and commits every agent mount", async (t) => {
  const fixtureRoot = createFixture("scout-boot-environment-");
  const runtime = installEnvironmentScope(fixtureRoot, "boot-environment-test");
  t.after(runtime.release);
  const preflightedAgents: string[] = [];
  const stage = new BootEnvironmentStage({
    preflightMount: async (input) => {
      assert.equal(input.appServer, runtime.appServer);
      preflightedAgents.push(input.mount.agentId);
      return { status: "passed" };
    },
  });

  await stage.start();

  const roles = Object.values(ScoutAgentRoles);
  assert.deepEqual(preflightedAgents.sort(), [...roles].sort());
  assert.deepEqual(Object.keys(stage.agents).sort(), [...roles].sort());
  for (const role of roles) {
    const agent = stage.agents[role];
    assert.equal(
      agent.mount.mountRoot,
      join(fixtureRoot, "run", stage.runId, "agents", role, "mount"),
    );
    assert.ok(existsSync(agent.preflightPath));
    assert.ok(existsSync(agent.assetCommitPath));
    assert.equal(agent.assetCommit.status, "preflight_passed");
    assert.equal(agent.assetCommit.preflightRef, agent.preflightPath);
    assert.equal(JSON.parse(readFileSync(agent.preflightPath, "utf8")).status, "passed");
  }
  assert.ok(stage.rootAccess.trustedRoots.includes(resolve(fixtureRoot)));
  assert.ok(stage.rootAccess.trustedRoots.includes(resolve(homedir(), ".guru", "knowledge")));
  assert.ok(stage.rootAccess.writableRoots.includes(resolve(homedir(), ".guru", "codebase")));
  assert.equal(runtime.scope.environment.agents, stage.agents);
  assert.equal(runtime.scope.environment.rootAccess, stage.rootAccess);
  assert.equal(
    runtime.scope.contextBundle.assetCommit.assetCommitId,
    stage.agents.coordinator.assetCommit.assetCommitId,
  );
});

test("BootEnvironmentStage preserves failed preflight artifacts and rejects startup", async (t) => {
  const fixtureRoot = createFixture("scout-boot-environment-failed-");
  const runtime = installEnvironmentScope(fixtureRoot, "boot-environment-failed");
  t.after(runtime.release);
  const stage = new BootEnvironmentStage({
    preflightMount: async () => ({ status: "failed" }),
  });

  await assert.rejects(stage.start(), /preflight failed/);

  assert.equal(stage.prepared, true);
  assert.ok(Object.values(stage.agents).every((agent) =>
    agent.assetCommit.status === "preflight_failed"
  ));
  assert.ok(Object.values(stage.agents).every((agent) =>
    existsSync(agent.preflightPath) && existsSync(agent.assetCommitPath)
  ));
  assert.equal(runtime.scope.hasEnvironment, true);
  assert.ok(Object.values(runtime.scope.environment.agents).every((agent) =>
    agent.assetCommit.status === "preflight_failed"
  ));
});

function createFixture(prefix: string): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  return fixtureRoot;
}

function installEnvironmentScope(repoRoot: string, runId: string): {
  scope: RunScope;
  appServer: CodexAppServerClient;
  release(): void;
} {
  const appServer = {} as CodexAppServerClient;
  const scope = new RunScope({
    runId,
    repoRoot,
    logger: noopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: {
      domainId: "test",
      name: "test",
      dynamicToolsForRole: () => [],
    },
    terminate: async () => undefined,
  });
  scope.setAppServer(appServer);
  const releaseScope = installRunScope(scope);
  return {
    scope,
    appServer,
    release() {
      scope.clearAppServer(appServer);
      releaseScope();
    },
  };
}

function noopLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}
