import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { WorkflowBenchmarks } from "../../src/core/workflow/workflow-benchmarks.js";

test("Different Runs keep their Workflow directories, permalinks and locks inside their own Run root", (t) => {
  const scoutRoot = mkdtempSync(join(tmpdir(), "scout-workflow-isolated-runs-"));
  const leftRoot = join(scoutRoot, "run", "run-left");
  const rightRoot = join(scoutRoot, "run", "run-right");
  const left = new WorkflowBenchmarks(leftRoot);
  const right = new WorkflowBenchmarks(rightRoot);
  t.after(() => {
    left.release();
    right.release();
    rmSync(scoutRoot, { recursive: true, force: true });
  });
  left.acquire();
  right.acquire();
  assert.equal(left.runRoot, leftRoot);
  assert.equal(left.path, join(leftRoot, "benchmarks.json"));
  assert.equal(right.path, join(rightRoot, "benchmarks.json"));
  assert.equal(existsSync(join(leftRoot, ".workflow.lock")), true);
  assert.equal(existsSync(join(rightRoot, ".workflow.lock")), true);
  const firstLeft = left.prepareNext();
  const firstRight = right.prepareNext();
  assert.deepEqual(firstLeft, { workflowId: "workflow-001", workflowRoot: join(leftRoot, "workflows", "workflow-001"), journalRoot: join(leftRoot, "workflows", "workflow-001", "journal") });
  assert.deepEqual(firstRight, { workflowId: "workflow-001", workflowRoot: join(rightRoot, "workflows", "workflow-001"), journalRoot: join(rightRoot, "workflows", "workflow-001", "journal") });
  left.recordStarted(firstLeft.workflowId);
  right.recordStarted(firstRight.workflowId);
  right.recordSuccess(firstRight.workflowId);
  const rightLinks = readFileSync(right.path, "utf8");
  const rightLock = readFileSync(join(rightRoot, ".workflow.lock"), "utf8");
  const nextLeft = left.prepareNext();
  left.recordStarted(nextLeft.workflowId);
  assert.equal(left.read()?.currentWorkflow, "workflow-002");
  assert.equal(readFileSync(right.path, "utf8"), rightLinks);
  assert.deepEqual(right.resolve("currentWorkflow"), firstRight);
  left.release();
  assert.equal(readFileSync(join(rightRoot, ".workflow.lock"), "utf8"), rightLock);
  assert.throws(() => new WorkflowBenchmarks(rightRoot).acquire(), /already attached/);
  assert.equal(existsSync(join(scoutRoot, "run", "benchmarks.json")), false);
  assert.equal(existsSync(join(scoutRoot, "run", ".workflow.lock")), false);
  assert.equal(existsSync(join(scoutRoot, "run", "workflow-001")), false);
});

test("Workflow benchmarks allocate numbered Workflow directories and preserve stable permalinks", (t) => {
  const runRoot = mkdtempSync(join(tmpdir(), "scout-workflow-benchmarks-"));
  t.after(() => { benchmarks.release(); rmSync(runRoot, { recursive: true, force: true }); });
  const benchmarks = new WorkflowBenchmarks(runRoot);
  benchmarks.acquire();

  const first = benchmarks.prepareNext();
  assert.equal(first.workflowId, "workflow-001");
  assert.equal(basename(first.workflowRoot), first.workflowId);
  assert.deepEqual(JSON.parse(readFileSync(join(first.workflowRoot, "workflow.json"), "utf8")), {
    workflowId: "workflow-001",
  });
  assert.equal(existsSync(join(first.workflowRoot, "flow.json")), false);
  writeFileSync(join(first.journalRoot, "scout.journal"), "first\n", "utf8");
  benchmarks.recordStarted(first.workflowId);
  benchmarks.recordSuccess(first.workflowId);

  const collision = join(runRoot, "workflows", "workflow-002");
  mkdirSync(collision, { recursive: true });
  writeFileSync(join(collision, "stale"), "stale", "utf8");
  const preparedCollision = benchmarks.prepareNext();
  assert.equal(preparedCollision.workflowRoot, collision);
  assert.equal(existsSync(join(collision, "stale")), false);
  // The permalink is deliberately unchanged until the prepared Workflow is valid.
  assert.equal(benchmarks.read()?.currentWorkflow, "workflow-001");
  const links = benchmarks.recordStarted(preparedCollision.workflowId);

  assert.deepEqual(links, {
    version: 1,
    currentWorkflow: "workflow-002",
    lastWorkflow: "workflow-002",
    lastRun: "workflow-002",
    lastSuccess: "workflow-001",
  });
  assert.deepEqual(JSON.parse(readFileSync(benchmarks.path, "utf8")), { scout: links });
  assert.equal(existsSync(join(first.journalRoot, "scout.journal")), true);
});

test("Workflow contracts do not resolve legacy Flow field or identity-file aliases", (t) => {
  const runRoot = mkdtempSync(join(tmpdir(), "scout-workflow-contract-"));
  const benchmarks = new WorkflowBenchmarks(runRoot);
  t.after(() => { benchmarks.release(); rmSync(runRoot, { recursive: true, force: true }); });
  benchmarks.acquire();
  const legacyLinks = JSON.stringify({ scout: {
    version: 1, currentFlow: "workflow-001", lastFlow: "workflow-001", lastRun: "workflow-001",
  } });
  writeFileSync(benchmarks.path, legacyLinks);
  assert.throws(() => benchmarks.read(), /currentWorkflow must not be empty/);
  assert.equal(readFileSync(benchmarks.path, "utf8"), legacyLinks);

  const workflowRoot = join(runRoot, "workflows", "imported evidence");
  mkdirSync(workflowRoot, { recursive: true });
  const legacyIdentity = JSON.stringify({ flowId: "workflow-001" });
  writeFileSync(join(workflowRoot, "flow.json"), legacyIdentity);
  assert.equal(benchmarks.findWorkflow("workflow-001"), undefined);
  assert.equal(readFileSync(join(workflowRoot, "flow.json"), "utf8"), legacyIdentity);

  writeFileSync(join(workflowRoot, "workflow.json"), legacyIdentity);
  assert.throws(() => benchmarks.findWorkflow("workflow-001"), /Invalid Workflow identity/);
});

test("Workflow benchmarks reject an explicitly empty permalink", (t) => {
  const runRoot = mkdtempSync(join(tmpdir(), "scout-workflow-empty-link-"));
  t.after(() => { benchmarks.release(); rmSync(runRoot, { recursive: true, force: true }); });
  const benchmarks = new WorkflowBenchmarks(runRoot);
  benchmarks.acquire();
  const first = benchmarks.prepareNext();
  benchmarks.recordStarted(first.workflowId);
  const links = JSON.parse(readFileSync(benchmarks.path, "utf8")) as Record<string, unknown>;
  (links.scout as Record<string, unknown>).currentWorkflow = "";
  writeFileSync(benchmarks.path, `${JSON.stringify(links, null, 2)}\n`, "utf8");

  assert.throws(
    () => benchmarks.resolve("currentWorkflow"),
    /Workflow benchmark currentWorkflow must not be empty/,
  );
});

test("Workflow benchmarks do not overwrite a Workflow still pinned by a permalink", (t) => {
  const runRoot = mkdtempSync(join(tmpdir(), "scout-workflow-pinned-workflow-"));
  t.after(() => { benchmarks.release(); rmSync(runRoot, { recursive: true, force: true }); });
  const benchmarks = new WorkflowBenchmarks(runRoot);
  benchmarks.acquire();
  const first = benchmarks.prepareNext();
  benchmarks.recordStarted(first.workflowId);
  const pinned = join(runRoot, "workflows", "workflow-002");
  mkdirSync(pinned, { recursive: true });
  writeFileSync(join(pinned, "scout.journal"), "pinned\n", "utf8");
  const links = benchmarks.read();
  assert.ok(links);
  writeFileSync(benchmarks.path, `${JSON.stringify({
    scout: { ...links, lastSuccess: "workflow-002" },
  }, null, 2)}\n`, "utf8");

  assert.throws(
    () => benchmarks.prepareNext(),
    /referenced by lastSuccess/,
  );
  assert.equal(existsSync(join(pinned, "scout.journal")), true);
});

test("Workflow benchmarks refuse to discard a committed Workflow", (t) => {
  const runRoot = mkdtempSync(join(tmpdir(), "scout-workflow-committed-workflow-"));
  t.after(() => { benchmarks.release(); rmSync(runRoot, { recursive: true, force: true }); });
  const benchmarks = new WorkflowBenchmarks(runRoot);
  benchmarks.acquire();
  const prepared = benchmarks.prepareNext();
  const journalPath = join(prepared.journalRoot, "scout.journal");
  writeFileSync(journalPath, "committed\n", "utf8");
  benchmarks.recordStarted(prepared.workflowId);

  assert.throws(() => benchmarks.discard(prepared), /Cannot discard.*referenced by currentWorkflow/);
  assert.equal(readFileSync(journalPath, "utf8"), "committed\n");
});

test("Scout pointer updates preserve other namespaces and renamed Workflow identity", (t) => {
  const runRoot = mkdtempSync(join(tmpdir(), "scout-shared-benchmarks-"));
  const benchmarks = new WorkflowBenchmarks(runRoot);
  t.after(() => { benchmarks.release(); rmSync(runRoot, { recursive: true, force: true }); });
  benchmarks.acquire();
  const preparedWorkflow = benchmarks.prepareNext();
  benchmarks.recordStarted(preparedWorkflow.workflowId);
  const rbt = { catalog: { bdd: { version: { lastRun: preparedWorkflow.workflowId, arbitraryFact: ["keep", 42] } } } };
  writeFileSync(benchmarks.path, JSON.stringify({ scout: benchmarks.read(), rbt }));
  const renamedRoot = join(runRoot, "workflows", "bdd version");
  renameSync(preparedWorkflow.workflowRoot, renamedRoot);
  benchmarks.recordSuccess(preparedWorkflow.workflowId);
  assert.deepEqual(JSON.parse(readFileSync(benchmarks.path, "utf8")).rbt, rbt);
  assert.deepEqual(benchmarks.resolve("currentWorkflow"), { workflowId: preparedWorkflow.workflowId, workflowRoot: renamedRoot, journalRoot: join(renamedRoot, "journal") });
  mkdirSync(preparedWorkflow.workflowRoot);
  writeFileSync(join(preparedWorkflow.workflowRoot, "workflow.json"), JSON.stringify({ workflowId: preparedWorkflow.workflowId }));
  assert.throws(() => benchmarks.resolve("currentWorkflow"), /Duplicate Workflow identity/);
});

test("Workflow lookup and allocation only use workflows, not sibling Run directories", (t) => {
  const runRoot = mkdtempSync(join(tmpdir(), "scout-workflows-root-"));
  const benchmarks = new WorkflowBenchmarks(runRoot);
  t.after(() => { benchmarks.release(); rmSync(runRoot, { recursive: true, force: true }); });
  benchmarks.acquire();
  const siblingWorkflow = join(runRoot, "workflow-001");
  mkdirSync(siblingWorkflow);
  const siblingIdentity = JSON.stringify({ workflowId: "workflow-001" });
  writeFileSync(join(siblingWorkflow, "workflow.json"), siblingIdentity);
  for (const name of ["agents", "codex-home", "logs"]) {
    mkdirSync(join(runRoot, name));
    writeFileSync(join(runRoot, name, "workflow.json"), "not a Workflow identity");
  }

  assert.equal(benchmarks.findWorkflow("workflow-001"), undefined);
  assert.equal(existsSync(join(runRoot, "workflows")), false);
  const prepared = benchmarks.prepareNext();
  benchmarks.recordStarted(prepared.workflowId);
  assert.equal(prepared.workflowRoot, join(runRoot, "workflows", "workflow-001"));
  assert.deepEqual(benchmarks.resolve("currentWorkflow"), prepared);
  assert.equal(readFileSync(join(siblingWorkflow, "workflow.json"), "utf8"), siblingIdentity);
  for (const name of ["agents", "codex-home", "logs"]) {
    assert.equal(readFileSync(join(runRoot, name, "workflow.json"), "utf8"), "not a Workflow identity");
  }
});

test("Prepared Workflow cleanup rejects a sibling Run directory and preserves the workflows root", (t) => {
  const runRoot = mkdtempSync(join(tmpdir(), "scout-workflows-discard-"));
  const benchmarks = new WorkflowBenchmarks(runRoot);
  t.after(() => { benchmarks.release(); rmSync(runRoot, { recursive: true, force: true }); });
  benchmarks.acquire();
  const prepared = benchmarks.prepareNext();
  const siblingWorkflow = join(runRoot, prepared.workflowId);
  mkdirSync(join(siblingWorkflow, "journal"), { recursive: true });
  writeFileSync(join(siblingWorkflow, "journal", "scout.journal"), "preserve sibling evidence\n");

  assert.throws(() => benchmarks.discard({
    ...prepared,
    workflowRoot: siblingWorkflow,
    journalRoot: join(siblingWorkflow, "journal"),
  }), /Prepared Workflow root does not match/);
  assert.equal(existsSync(prepared.workflowRoot), true);
  benchmarks.discard(prepared);
  assert.equal(existsSync(prepared.workflowRoot), false);
  assert.equal(existsSync(join(runRoot, "workflows")), true);
  assert.equal(existsSync(join(runRoot, ".workflow.lock")), true);
  assert.equal(readFileSync(join(siblingWorkflow, "journal", "scout.journal"), "utf8"), "preserve sibling evidence\n");
});
