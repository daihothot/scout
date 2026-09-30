import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../../src/asset-store/index.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { Logger } from "../../src/core/logging/index.js";
import { Workflow } from "../../src/core/workflow/index.js";
import { BaseDomain, ScoutDomainId } from "../../src/domain/index.js";
import { RbtDomain, RbtDomainAgentBackend } from "../../src/domain/domains/rbt/index.js";
import { ValidationDomain } from "../../src/domain/domains/validation/index.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/index.js";
import { DomainStage } from "../../src/run/lifecycle/stages/domain-stage.js";
import { RunManifestStore } from "../../src/run/persistence/index.js";
import { installRunScope, RunScope } from "../../src/run/run-scope.js";
import { createDefaultTestGraph, createTestWorkflowAsset } from "../helpers/run-persistence.js";

test("DomainStage registers Base and the selected business Domain before startup and stops in reverse", async (t) => {
  const scope = installDomainStageScope(t);
  const events: string[] = [];
  const expected = [ScoutDomainId.Base, ScoutDomainId.Rbt];
  const onStart = (id: ScoutDomainId): void => {
    assert.deepEqual(scope.domainRegistry.list().map((domain) => domain.description.id), expected);
    events.push(`start:${id}`);
  };
  t.mock.method(BaseDomain.prototype, "start", () => onStart(ScoutDomainId.Base));
  t.mock.method(RbtDomain.prototype, "start", async () => onStart(ScoutDomainId.Rbt));
  t.mock.method(ValidationDomain.prototype, "start", async () => onStart(ScoutDomainId.Validation));
  t.mock.method(BaseDomain.prototype, "stop", () => { events.push("stop:base"); });
  t.mock.method(RbtDomain.prototype, "stop", async () => { events.push("stop:rbt"); });
  t.mock.method(ValidationDomain.prototype, "stop", async () => { events.push("stop:validation"); });
  const stage = new DomainStage();

  await stage.start();
  const instances = scope.domainRegistry.list();
  assert.ok(instances[0] instanceof BaseDomain);
  assert.ok(instances[1] instanceof RbtDomain);
  assert.equal(instances.length, 2);
  await stage.start();
  assert.deepEqual(scope.domainRegistry.list(), instances);
  assert.deepEqual(events, ["start:base", "start:rbt"]);

  await stage.stop();
  await stage.stop();
  assert.deepEqual(events, [
    "start:base", "start:rbt",
    "stop:rbt", "stop:base",
  ]);
  assert.deepEqual(scope.domainRegistry.list(), []);
});

for (const selectedDomain of ["", "base", "missing-domain"]) {
  test(`DomainStage rejects invalid selection ${selectedDomain} before registration`, async (t) => {
    const scope = installDomainStageScope(t);
    const graph = scope.workflow.graph.snapshot();
    // Inject an invalid incoming snapshot to exercise Stage's own preflight boundary.
    t.mock.method(scope.workflow.graph, "snapshot", () => ({ ...graph, domain: selectedDomain }));
    const register = t.mock.method(scope.domainRegistry, "register");
    await assert.rejects(new DomainStage().start(), /one specialized Domain id/);
    assert.equal(register.mock.callCount(), 0);
    assert.deepEqual(scope.domainRegistry.list(), []);
  });
}

test("DomainStage preserves a failed startup cleanup owner while releasing the other registered Domains", async (t) => {
  const scope = installDomainStageScope(t);
  const events: string[] = [];
  const startFailure = new Error("RBT startup failed");
  const stopFailure = new Error("RBT resource remains open");
  let failCleanup = true;
  t.mock.method(BaseDomain.prototype, "start", () => { events.push("start:base"); });
  t.mock.method(RbtDomain.prototype, "start", async () => {
    events.push("start:rbt");
    throw startFailure;
  });
  const validationStart = t.mock.method(ValidationDomain.prototype, "start", async () => {});
  t.mock.method(BaseDomain.prototype, "stop", () => { events.push("stop:base"); });
  t.mock.method(RbtDomain.prototype, "stop", async () => {
    events.push("stop:rbt");
    if (failCleanup) throw stopFailure;
  });
  t.mock.method(ValidationDomain.prototype, "stop", async () => { events.push("stop:validation"); });
  const stage = new DomainStage();

  await assert.rejects(stage.start(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [startFailure, stopFailure]);
    return true;
  });
  assert.equal(validationStart.mock.callCount(), 0);
  assert.deepEqual(events, ["start:base", "start:rbt", "stop:rbt", "stop:base"]);
  const retained = scope.domainRegistry.get(ScoutDomainId.Rbt);
  assert.deepEqual(scope.domainRegistry.list(), [retained]);
  await assert.rejects(stage.start(), /registered runtimes still require cleanup/);

  failCleanup = false;
  await stage.stop();
  assert.deepEqual(events.slice(-1), ["stop:rbt"]);
  assert.deepEqual(scope.domainRegistry.list(), []);
});

test("DomainStage releases previously registered Domains when a later Domain cannot be loaded", async (t) => {
  const scope = installDomainStageScope(t);
  const graph = scope.workflow.graph.snapshot();
  t.mock.method(scope.workflow.graph, "snapshot", () => ({
    ...graph, domain: ScoutDomainId.Rbt,
  }));
  const events: string[] = [];
  const baseStart = t.mock.method(BaseDomain.prototype, "start", () => {});
  const validationStart = t.mock.method(ValidationDomain.prototype, "start", async () => {});
  t.mock.method(BaseDomain.prototype, "stop", () => { events.push("base"); });
  t.mock.method(ValidationDomain.prototype, "stop", async () => { events.push("validation"); });
  const backendDescriptor = Object.getOwnPropertyDescriptor(RbtDomainAgentBackend.prototype, "handleDynamicToolCall");
  assert.ok(backendDescriptor);
  Object.defineProperty(RbtDomainAgentBackend.prototype, "handleDynamicToolCall", {
    ...backendDescriptor, value: undefined,
  });
  t.after(() => Object.defineProperty(RbtDomainAgentBackend.prototype, "handleDynamicToolCall", backendDescriptor));

  await assert.rejects(new DomainStage().start(), /Workflow domain rbt returned an invalid Domain backend/);
  assert.equal(baseStart.mock.callCount(), 0);
  assert.equal(validationStart.mock.callCount(), 0);
  assert.deepEqual(events, ["base"]);
  assert.deepEqual(scope.domainRegistry.list(), []);
});

test("DomainStage stop retains only the failing Domain and retries that same instance", async (t) => {
  const scope = installDomainStageScope(t, ScoutDomainId.Validation);
  const events: string[] = [];
  const stopFailure = new Error("Validation resource remains open");
  let failCleanup = true;
  t.mock.method(BaseDomain.prototype, "start", () => {});
  t.mock.method(RbtDomain.prototype, "start", async () => {});
  t.mock.method(ValidationDomain.prototype, "start", async () => {});
  t.mock.method(BaseDomain.prototype, "stop", () => { events.push("base"); });
  t.mock.method(RbtDomain.prototype, "stop", async () => { events.push("rbt"); });
  t.mock.method(ValidationDomain.prototype, "stop", async () => {
    events.push("validation");
    if (failCleanup) throw stopFailure;
  });
  const stage = new DomainStage();
  await stage.start();
  const retained = scope.domainRegistry.get(ScoutDomainId.Validation);

  await assert.rejects(stage.stop(), (error) => error === stopFailure);
  assert.deepEqual(events, ["validation", "base"]);
  assert.deepEqual(scope.domainRegistry.list(), [retained]);
  failCleanup = false;
  await stage.stop();
  assert.deepEqual(events, ["validation", "base", "validation"]);
  assert.deepEqual(scope.domainRegistry.list(), []);
});

function installDomainStageScope(t: TestContext, domain = ScoutDomainId.Rbt): RunScope {
  const root = mkdtempSync(join(tmpdir(), "scout-domain-stage-multiple-"));
  const runId = "run-domain-stage-multiple";
  const runRoot = join(root, "run", runId);
  const scope = new RunScope({
    runId,
    scoutRoot: root,
    runRoot,
    config: new AssetStore().config(root),
    workflow: new Workflow(createTestWorkflowAsset({
        ...createDefaultTestGraph().snapshot(),
        domain,
      })),
    manifestStore: new RunManifestStore(runRoot),
    logger: new Logger({ runId, logsRoot: join(runRoot, "logs") }),
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    terminate: async () => {},
  });
  scope.setExecutionSystem({
    identify: async () => { throw new Error("Lifecycle tests cannot execute platform commands."); },
    launch: async () => { throw new Error("Lifecycle tests cannot execute platform commands."); },
    shutdown: async () => { throw new Error("Lifecycle tests cannot execute platform commands."); },
  });
  const release = installRunScope(scope);
  t.after(() => {
    release();
    rmSync(root, { recursive: true, force: true });
  });
  return scope;
}
