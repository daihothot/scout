import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Benchmarks, type BenchmarkObject, type BenchmarkValue } from "../../src/core/benchmarks/index.js";

function fixture(t: TestContext): Benchmarks {
  const root = mkdtempSync(join(tmpdir(), "scout-benchmark-nodes-"));
  const benchmarks = new Benchmarks(root);
  t.after(() => { benchmarks.release(); rmSync(root, { recursive: true, force: true }); });
  benchmarks.acquire();
  return benchmarks;
}

test("Benchmarks store business-owned nodes without adding fields and preserve independent chapters", async (t) => {
  const benchmarks = await fixture(t);
  assert.equal(existsSync(benchmarks.path), false);
  assert.equal(benchmarks.read("scout"), undefined);
  assert.deepEqual(benchmarks.list("rbt"), []);
  const scout = { currentWorkflow: { workflowId: "workflow-001" } };
  benchmarks.submit("scout", [{ path: [], value: scout }]);
  benchmarks.submit("rbt", [
    { path: ["business", "lastRun"], value: { workflowId: "workflow-001", note: "fact, not a reuse decision" } },
    { path: ["business", "passedPlatforms"], value: ["unity-editor"] },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(benchmarks.path, "utf8")), {
    scout,
    rbt: { business: { lastRun: { workflowId: "workflow-001", note: "fact, not a reuse decision" }, passedPlatforms: ["unity-editor"] } },
  });
  scout.currentWorkflow.workflowId = "workflow-999";
  const value = benchmarks.read("scout") as BenchmarkObject;
  value.changed = true;
  const children = benchmarks.list("scout");
  assert.deepEqual(children, [{ section: "scout", path: ["currentWorkflow"], value: { workflowId: "workflow-001" } }]);
  (children[0]!.value as BenchmarkObject).workflowId = "workflow-999";
  assert.deepEqual(benchmarks.read("scout"), { currentWorkflow: { workflowId: "workflow-001" } });
  assert.equal(benchmarks.read("rbt", ["missing", "child"]), undefined);
  assert.throws(() => benchmarks.list("rbt", ["business", "lastRun", "note"]), /has no children/);
});

test("Node submissions reread manual edits and commit a batch without overwriting unrelated fields", async (t) => {
  const benchmarks = await fixture(t);
  benchmarks.submit("rbt", [{ path: ["history"], value: { lastRun: { workflowId: "workflow-001" } } }]);
  benchmarks.read("rbt");
  const manual = {
    rbt: { history: { lastRun: { workflowId: "workflow-077" }, lastSuccess: { workflowId: "workflow-002" } }, note: "operator" },
    anotherDomain: { businessFact: [true, null, 42] },
  };
  writeFileSync(benchmarks.path, JSON.stringify(manual));
  assert.deepEqual(benchmarks.read("rbt", ["history", "lastRun"]), { workflowId: "workflow-077" });
  benchmarks.submit("rbt", [
    { path: ["history", "lastRun"], value: { workflowId: "workflow-003" } },
    { path: ["summary", "count"], value: 3 },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(benchmarks.path, "utf8")), {
    ...manual,
    rbt: { ...manual.rbt, history: { ...manual.rbt.history, lastRun: { workflowId: "workflow-003" } }, summary: { count: 3 } },
  });
});

test("Only explicit Workflow references are indexed, including references in arrays", async (t) => {
  const benchmarks = await fixture(t);
  const reference = { workflowId: "workflow-004", pack: { artifact: "execute-file.json", hash: "abc" } };
  benchmarks.submit("scout", [{ path: ["currentWorkflow"], value: { workflowId: "workflow-004" } }]);
  benchmarks.submit("rbt", [{ path: [], value: {
    history: { pack: reference, other: { workflowId: "workflow-005" } },
    facts: ["workflow-004", reference],
    note: "workflow-004",
  } }]);
  const matches = benchmarks.referencesTo("workflow-004");
  assert.deepEqual(matches.map(({ section, path }) => ({ section, path })), [
    { section: "scout", path: ["currentWorkflow"] },
    { section: "rbt", path: ["history", "pack"] },
    { section: "rbt", path: ["facts", "1"] },
  ]);
  for (const match of matches) assert.deepEqual(benchmarks.read(match.section, match.path), match.reference);
  assert.deepEqual(benchmarks.list("rbt", ["facts"]).map(({ path }) => path), [["facts", "0"], ["facts", "1"]]);
  assert.deepEqual(benchmarks.referencesTo("workflow-006"), []);
  matches[1]!.reference.workflowId = "workflow-999";
  assert.equal(benchmarks.referencesTo("workflow-004").length, 3);
});

test("Workflow resolution follows its identity after rename, allows missing evidence and rejects duplicates", async (t) => {
  const benchmarks = await fixture(t);
  const reference = { workflowId: "workflow-008" };
  benchmarks.submit("rbt", [{ path: ["history"], value: reference }]);
  assert.equal(benchmarks.resolve(reference), undefined);
  const initialRoot = join(benchmarks.runRoot, "workflows", "workflow-008");
  const renamedRoot = join(benchmarks.runRoot, "workflows", "firebase 1.2.3");
  mkdirSync(join(initialRoot, "journal"), { recursive: true });
  writeFileSync(join(initialRoot, "workflow.json"), JSON.stringify(reference));
  const contents = readFileSync(benchmarks.path, "utf8");
  renameSync(initialRoot, renamedRoot);
  assert.deepEqual(benchmarks.resolve(reference), { workflowId: reference.workflowId, workflowRoot: renamedRoot, journalRoot: join(renamedRoot, "journal") });
  assert.equal(readFileSync(benchmarks.path, "utf8"), contents);
  mkdirSync(initialRoot);
  writeFileSync(join(initialRoot, "workflow.json"), JSON.stringify(reference));
  assert.throws(() => benchmarks.resolve(reference), /Duplicate Workflow identity/);
});

test("Invalid batches and filesystem write failures leave the previous document intact", async (t) => {
  const benchmarks = await fixture(t);
  benchmarks.submit("rbt", [{ path: [], value: { kept: 7, leaf: false } }]);
  const before = readFileSync(benchmarks.path, "utf8");
  assert.throws(() => benchmarks.submit("rbt", [
    { path: ["kept"], value: 8 },
    { path: ["leaf", "child"], value: 1 },
  ]), /non-object benchmark node/);
  assert.equal(readFileSync(benchmarks.path, "utf8"), before);
  const cyclic: BenchmarkObject = {};
  cyclic.self = cyclic;
  for (const value of [NaN, Infinity, undefined, new Date(), cyclic, { workflowId: "" }, { workflowId: "../workflow-001" }]) {
    assert.throws(() => benchmarks.submit("rbt", [
      { path: ["kept"], value: 8 }, { path: ["bad"], value: value as BenchmarkValue },
    ]));
    assert.equal(readFileSync(benchmarks.path, "utf8"), before);
  }
  assert.throws(() => benchmarks.submit("rbt", [{ path: [], value: [] }]), /chapter must be an object/);
  assert.throws(() => benchmarks.submit("rbt", [{ path: ["__proto__", "bad"], value: true }]), /Invalid benchmark address/);
  mkdirSync(`${benchmarks.path}.${process.pid}.tmp`);
  assert.throws(() => benchmarks.submit("rbt", [{ path: ["kept"], value: 8 }]), /EISDIR/);
  assert.equal(readFileSync(benchmarks.path, "utf8"), before);
});

test("All chapters share the Workflow lease while read-only consumers do not acquire ownership", async (t) => {
  const benchmarks = await fixture(t);
  benchmarks.submit("scout", [{ path: ["currentWorkflow"], value: { workflowId: "workflow-001" } }]);
  const reader = new Benchmarks(benchmarks.runRoot);
  assert.deepEqual(reader.read("scout"), benchmarks.read("scout"));
  assert.throws(() => reader.submit("rbt", [{ path: [], value: {} }]), /lock must be acquired/);
  assert.throws(() => reader.acquire(), /already attached/);
  benchmarks.release();
  assert.throws(() => benchmarks.submit("rbt", [{ path: [], value: {} }]), /lock must be acquired/);
  reader.acquire();
  try { reader.submit("rbt", [{ path: [], value: {} }]); }
  finally { reader.release(); }
  assert.deepEqual(benchmarks.read("rbt"), {});
});

test("Malformed documents and references fail without rewriting operator data", async (t) => {
  const benchmarks = await fixture(t);
  for (const contents of ["{", "[]", "null", '{"version":1}', '{"rbt":[]}', '{"rbt":{"history":{"workflowId":null}}}']) {
    writeFileSync(benchmarks.path, contents);
    assert.throws(() => benchmarks.read("rbt"));
    assert.throws(() => benchmarks.submit("scout", [{ path: [], value: {} }]));
    assert.equal(readFileSync(benchmarks.path, "utf8"), contents);
  }
});
