import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DomainBenchmarks, ScoutDomainId } from "../../src/domain/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

// This fixture exercises submission ownership, not any production Domain schema.
class TestDomainBenchmarks extends DomainBenchmarks {
  constructor(id: ScoutDomainId) { super(id); }
  record(workflowId: string): void {
    this.submit([{ path: ["history", "lastRun"], value: { workflowId } }]);
  }
}

test("Domain submissions use the shared Workflow service and preserve other chapters across executions", async (t) => {
  const scope = await installTestRunScope(t, { runId: "domain-benchmarks" });
  const service = scope.workflow.benchmarks;
  const base = new TestDomainBenchmarks(ScoutDomainId.Base);
  const rbt = new TestDomainBenchmarks(ScoutDomainId.Rbt);
  assert.equal(base.domainId, ScoutDomainId.Base);
  assert.equal(rbt.domainId, ScoutDomainId.Rbt);
  assert.equal(service.read("base"), undefined);
  assert.equal(service.read("rbt"), undefined);
  const scout = service.read("scout");
  const submit = t.mock.method(service, "submit");
  base.record("workflow-001");
  rbt.record("workflow-001");
  assert.equal(submit.mock.callCount(), 2);
  assert.deepEqual(submit.mock.calls.map(({ arguments: args }) => args[0]), ["base", "rbt"]);
  assert.deepEqual(service.read("scout"), scout);
  assert.deepEqual(service.read("rbt", ["history", "lastRun"]), { workflowId: "workflow-001" });
  assert.deepEqual(service.referencesTo("workflow-001").map(({ section }) => section), ["scout", "scout", "scout", "base", "rbt"]);

  await scope.workflow.advance("error");

  assert.equal(scope.workflow.snapshot(), undefined);
  assert.equal(scope.workflow.benchmarks, service);
  assert.deepEqual(service.read("rbt", ["history", "lastRun"]), { workflowId: "workflow-001" });
  await scope.workflow.startWorkflow();
  assert.equal(scope.workflow.benchmarks, service);
  rbt.record(scope.workflow.snapshot()!.workflowId);
  assert.deepEqual(service.read("rbt", ["history", "lastRun"]), { workflowId: "workflow-002" });
  assert.deepEqual(service.read("base", ["history", "lastRun"]), { workflowId: "workflow-001" });
  const beforeStop = readFileSync(service.path, "utf8");
  await scope.workflow.stop();
  assert.throws(() => scope.workflow.benchmarks, /Benchmarks are unavailable/);
  assert.throws(() => rbt.record("workflow-003"), /Benchmarks are unavailable/);
  assert.equal(readFileSync(service.path, "utf8"), beforeStop);
});
