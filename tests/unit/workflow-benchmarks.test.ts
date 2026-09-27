import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { WorkflowBenchmarks } from "../../src/core/workflow/workflow-benchmarks.js";

test("Different Runs keep their Flow directories, permalinks and locks inside their own Run root", (t) => {
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
  assert.deepEqual(firstLeft, { flowId: "journal-0001", journalRoot: join(leftRoot, "journal-0001") });
  assert.deepEqual(firstRight, { flowId: "journal-0001", journalRoot: join(rightRoot, "journal-0001") });
  left.recordStarted(firstLeft.flowId);
  right.recordStarted(firstRight.flowId);
  right.recordSuccess(firstRight.flowId);
  const rightLinks = readFileSync(right.path, "utf8");
  const rightLock = readFileSync(join(rightRoot, ".workflow.lock"), "utf8");
  const nextLeft = left.prepareNext();
  left.recordStarted(nextLeft.flowId);
  assert.equal(left.read()?.currentFlow, "journal-0002");
  assert.equal(readFileSync(right.path, "utf8"), rightLinks);
  assert.deepEqual(right.resolve("currentFlow"), firstRight);
  left.release();
  assert.equal(readFileSync(join(rightRoot, ".workflow.lock"), "utf8"), rightLock);
  assert.throws(() => new WorkflowBenchmarks(rightRoot).acquire(), /already attached/);
  assert.equal(existsSync(join(scoutRoot, "run", "benchmarks.json")), false);
  assert.equal(existsSync(join(scoutRoot, "run", ".workflow.lock")), false);
  assert.equal(existsSync(join(scoutRoot, "run", "journal-0001")), false);
});

test("Workflow benchmarks allocate numbered Flow directories and preserve stable permalinks", (t) => {
  const runRoot = mkdtempSync(join(tmpdir(), "scout-workflow-benchmarks-"));
  t.after(() => { benchmarks.release(); rmSync(runRoot, { recursive: true, force: true }); });
  const benchmarks = new WorkflowBenchmarks(runRoot);
  benchmarks.acquire();

  const first = benchmarks.prepareNext();
  assert.equal(first.flowId, "journal-0001");
  assert.equal(basename(first.journalRoot), first.flowId);
  writeFileSync(join(first.journalRoot, "scout.journal"), "first\n", "utf8");
  benchmarks.recordStarted(first.flowId);
  benchmarks.recordSuccess(first.flowId);

  const collision = join(runRoot, "journal-0002");
  mkdirSync(collision, { recursive: true });
  writeFileSync(join(collision, "stale"), "stale", "utf8");
  const preparedCollision = benchmarks.prepareNext();
  assert.equal(preparedCollision.journalRoot, collision);
  assert.equal(existsSync(join(collision, "stale")), false);
  // The permalink is deliberately unchanged until the prepared Flow is valid.
  assert.equal(benchmarks.read()?.currentFlow, "journal-0001");
  const links = benchmarks.recordStarted(preparedCollision.flowId);

  assert.deepEqual(links, {
    version: 1,
    currentFlow: "journal-0002",
    lastFlow: "journal-0002",
    lastRun: "journal-0002",
    lastSuccess: "journal-0001",
  });
  assert.equal(existsSync(join(first.journalRoot, "scout.journal")), true);
});

test("Workflow benchmarks reject an explicitly empty permalink", (t) => {
  const runRoot = mkdtempSync(join(tmpdir(), "scout-workflow-empty-link-"));
  t.after(() => { benchmarks.release(); rmSync(runRoot, { recursive: true, force: true }); });
  const benchmarks = new WorkflowBenchmarks(runRoot);
  benchmarks.acquire();
  const first = benchmarks.prepareNext();
  benchmarks.recordStarted(first.flowId);
  const links = JSON.parse(readFileSync(benchmarks.path, "utf8")) as Record<string, unknown>;
  links.currentFlow = "";
  writeFileSync(benchmarks.path, `${JSON.stringify(links, null, 2)}\n`, "utf8");

  assert.throws(
    () => benchmarks.resolve("currentFlow"),
    /Workflow benchmark currentFlow must not be empty/,
  );
});

test("Workflow benchmarks do not overwrite a Flow still pinned by a permalink", (t) => {
  const runRoot = mkdtempSync(join(tmpdir(), "scout-workflow-pinned-flow-"));
  t.after(() => { benchmarks.release(); rmSync(runRoot, { recursive: true, force: true }); });
  const benchmarks = new WorkflowBenchmarks(runRoot);
  benchmarks.acquire();
  const first = benchmarks.prepareNext();
  benchmarks.recordStarted(first.flowId);
  const pinned = join(runRoot, "journal-0002");
  mkdirSync(pinned, { recursive: true });
  writeFileSync(join(pinned, "scout.journal"), "pinned\n", "utf8");
  const links = benchmarks.read();
  assert.ok(links);
  writeFileSync(benchmarks.path, `${JSON.stringify({
    ...links,
    lastSuccess: "journal-0002",
  }, null, 2)}\n`, "utf8");

  assert.throws(
    () => benchmarks.prepareNext(),
    /referenced by lastSuccess/,
  );
  assert.equal(existsSync(join(pinned, "scout.journal")), true);
});

test("Workflow benchmarks refuse to discard a committed Flow", (t) => {
  const runRoot = mkdtempSync(join(tmpdir(), "scout-workflow-committed-flow-"));
  t.after(() => { benchmarks.release(); rmSync(runRoot, { recursive: true, force: true }); });
  const benchmarks = new WorkflowBenchmarks(runRoot);
  benchmarks.acquire();
  const prepared = benchmarks.prepareNext();
  const journalPath = join(prepared.journalRoot, "scout.journal");
  writeFileSync(journalPath, "committed\n", "utf8");
  benchmarks.recordStarted(prepared.flowId);

  assert.throws(() => benchmarks.discard(prepared), /Cannot discard.*referenced by currentFlow/);
  assert.equal(readFileSync(journalPath, "utf8"), "committed\n");
});
