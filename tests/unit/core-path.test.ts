import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join, resolve, sep } from "node:path";
import {
  agentEntityPaths,
  workflowAgentPaths,
  workflowPaths,
  workflowRootFromJournalRoot,
  isPathWithin,
  runAgentPaths,
  runPaths,
  scoutJournalPaths,
  recordObjectPaths,
  authorizationJournalPaths,
  scoutRunRoot,
  scoutRunsRoot,
} from "../../src/core/io/index.js";

test("isPathWithin distinguishes roots, descendants, siblings, and prefixes", () => {
  const root = resolve(process.cwd(), "path-fixture", "root");
  const cases = [
    [root, root, true],
    [root, join(root, "child", "file.txt"), true],
    [root, join(dirname(root), "sibling"), false],
    [root, `${root}-sibling`, false],
    [root, join(root, "..", "outside"), false],
    [root, resolve(root, ".."), false],
  ] as const;

  for (const [candidateRoot, target, expected] of cases) {
    assert.equal(isPathWithin(candidateRoot, target), expected, `${candidateRoot} -> ${target}`);
  }
});

test("isPathWithin supports strict-child checks and platform separators", () => {
  const root = resolve(process.cwd(), "path-fixture", "root");
  const child = join(root, "nested", `file${sep}name`);

  assert.equal(isPathWithin(root, root, { allowRoot: false }), false);
  assert.equal(isPathWithin(root, join(root, "nested"), { allowRoot: false }), true);
  assert.equal(isPathWithin(root, child), true);
});

test("isPathWithin normalizes relative inputs lexically", () => {
  assert.equal(isPathWithin("path-fixture/root", "path-fixture/root/child"), true);
  assert.equal(isPathWithin("path-fixture/root", "path-fixture/root/../outside"), false);
});

test("Run layout resolves all persistent roots without an installed runtime", () => {
  const scoutRoot = resolve("path-fixture", "Scout project");
  const runRoot = join(scoutRoot, "run", "run-layout");
  assert.equal(scoutRunsRoot(scoutRoot), join(scoutRoot, "run"));
  assert.equal(scoutRunRoot(scoutRoot, "run-layout"), runRoot);
  assert.deepEqual(runPaths(runRoot), {
    agentsRoot: join(runRoot, "agents"),
    logsRoot: join(runRoot, "logs"),
    workflowsRoot: join(runRoot, "workflows"),
    manifestPath: join(runRoot, "run.json"),
    benchmarksPath: join(runRoot, "benchmarks.json"),
    workflowLockPath: join(runRoot, ".workflow.lock"),
    environmentRollbackPath: join(runRoot, "environment-rollback.json"),
    isolatedHome: join(runRoot, "codex-home"),
    codexHome: join(runRoot, "codex-home", ".codex"),
    codexSessionsRoot: join(runRoot, "codex-home", ".codex", "sessions"),
  });
});

test("Agent entity paths agree for creation and reads of an existing entity", () => {
  const runRoot = resolve("path-fixture", "run", "run-layout");
  const agentRoot = join(runRoot, "agents", "worker-1");
  const expected = {
    mountRoot: join(agentRoot, "mount"),
    mountManifestPath: join(agentRoot, "mount", "mount-manifest.json"),
    assetCommitPath: join(agentRoot, "asset-commit.json"),
    preflightPath: join(agentRoot, "app-server-preflight.json"),
    threadRecordPath: join(agentRoot, "thread.json"),
    logsRoot: join(agentRoot, "logs"),
  };
  assert.deepEqual(agentEntityPaths(agentRoot), expected);
  assert.deepEqual(runAgentPaths(runRoot, "worker-1"), { agentRoot, ...expected });
});

test("Workflow evidence paths follow physical directory names without interpreting Workflow identity", () => {
  const workflowsRoot = resolve("path-fixture", "run", "run-layout", "workflows");
  for (const directoryName of ["workflow-001", "firebase fallback v1", "workflow-002"]) {
    const workflowRoot = join(workflowsRoot, directoryName);
    const journalRoot = join(workflowRoot, "journal");
    assert.deepEqual(workflowPaths(workflowRoot), {
      identityPath: join(workflowRoot, "workflow.json"),
      agentsRoot: join(workflowRoot, "agents"),
      journalRoot,
    });
    assert.equal(workflowRootFromJournalRoot(journalRoot), workflowRoot);
    assert.deepEqual(workflowAgentPaths(workflowRoot, "worker-1"), {
      artifactRoot: join(workflowRoot, "agents", "worker-1", "artifacts"),
      logsRoot: join(workflowRoot, "agents", "worker-1", "logs"),
    });
    assert.deepEqual(scoutJournalPaths(journalRoot), {
      path: join(journalRoot, "scout.journal"),
      lockPath: join(journalRoot, ".scout.lock"),
    });
    assert.deepEqual(recordObjectPaths(journalRoot, "base.journal", ".base.lock"), {
      path: join(journalRoot, "base.journal"), lockPath: join(journalRoot, ".base.lock"),
    });
    assert.deepEqual(authorizationJournalPaths(journalRoot), {
      path: join(journalRoot, "authorization.journal"), lockPath: join(journalRoot, ".authorization.lock"),
    });
  }
});

test("Layout construction preserves relative paths instead of resolving them against a runtime", () => {
  assert.equal(scoutRunRoot("project", "run-1"), join("project", "run", "run-1"));
  assert.equal(runPaths("run-1").logsRoot, join("run-1", "logs"));
  assert.equal(runAgentPaths("run-1", "worker-1").mountRoot, join("run-1", "agents", "worker-1", "mount"));
  assert.equal(workflowAgentPaths("renamed workflow", "worker-1").artifactRoot, join("renamed workflow", "agents", "worker-1", "artifacts"));
});
