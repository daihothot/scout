import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { buildWorkflow } from "../../src/asset-store/builders/workflow-builder.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { Graph } from "../../src/core/workflow/index.js";
import { BaseDomain, ScoutDomainId, type ScoutDomainDynamicToolCall } from "../../src/domain/index.js";
import { RbtDomain, RbtDomainProjector } from "../../src/domain/domains/rbt/index.js";
import { decodeRbtRecords } from "../../src/domain/domains/rbt/record/rbt-record.js";
import { ScoutExecutionSystem, type ExecutionHandlerInvocation } from "../../src/execution/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("RBT starts without selecting or launching and binds only the Executor's task platform", async (t) => {
  const f = await fixture(t);
  const unconfigured = await f.base.execution.launch();
  assert.ok(!unconfigured.ok && unconfigured.code === "execution_not_configured");
  const premature = await f.domain.backend.handleDynamicToolCall({
    ...call({ platform: "unity_editor" }),
    input: { ...call({}).input, namespace: "rbt_behavior", tool: "JarvisBehavior",
      arguments: { command: "behavior.registry.nodes", payload: { domain: "Growth", category: "RemoteConfig" } } },
  });
  assert.equal(premature?.success, false);
  assert.match(premature?.contentItems[0]?.text ?? "", /SelectExecutionSource/);
  assert.equal(f.operations.length, 0);

  const selected = await f.domain.backend.handleDynamicToolCall(call({ platform: "android" }));
  assert.ok(selected?.success);
  assert.deepEqual(JSON.parse(selected.contentItems[0]!.text), { status: "selected", platform: "android" });
  assert.equal(f.operations.length, 0, "Choosing a source is not a physical launch");
  const records = f.domain.recordObject.read();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.kind, "execution-source");
  assert.deepEqual(records[0]!.payload, { platform: "android" });
  assert.equal(new RbtDomainProjector().project(records).executionPlatform, "android");
  assert.ok((await f.base.execution.launch()).ok);
  assert.deepEqual(f.operations[0]!.parameters, { transport: "adb" });
  assert.equal(f.operations[1]!.parameters.appId, "com.example.android");
});

test("RBT serializes source choices, reuses the same choice and rejects another platform", async (t) => {
  const f = await fixture(t);
  await Promise.all([f.domain.selectExecutionSource("unity_editor"), f.domain.selectExecutionSource("unity_editor")]);
  assert.equal(f.domain.recordObject.read().length, 1);
  await assert.rejects(f.domain.selectExecutionSource("android"), /already selected unity_editor/);
  assert.equal(f.domain.recordObject.read().length, 1);
  assert.ok((await f.base.execution.launch()).ok);
  assert.deepEqual(f.operations[0]!.parameters, { transport: "unity-pipeline" });
});

test("Selection checks external arguments, role Phase and unavailable configuration without guessing", async (t) => {
  const f = await fixture(t);
  for (const args of [{}, null, { platform: "windows" }, { platform: "android", appId: "override" }]) {
    const result = await f.domain.backend.handleDynamicToolCall(call(args));
    assert.equal(result?.success, false);
    assert.match(result?.contentItems[0]?.text ?? "", /requires one valid platform/);
  }
  for (const phase of ["Synthesis", "review"]) {
    const result = await f.domain.backend.handleDynamicToolCall(call({ platform: "android" }, phase));
    assert.equal(result?.success, false);
    assert.match(result?.contentItems[0]?.text ?? "", /only available in execute/);
  }
  await assert.rejects(f.domain.selectExecutionSource("ios"), /No RBT execution source/);
  assert.deepEqual(f.domain.recordObject.read(), []);
  assert.equal(f.operations.length, 0);
});

test("An unfinished Workflow restores its selection into a new Domain without new selection or physical work", async (t) => {
  const f = await fixture(t);
  await f.domain.selectExecutionSource("android");
  assert.ok((await f.base.execution.launch()).ok);
  const data = f.scope.workflow.snapshot()!;
  const path = f.domain.recordObject.path;
  const original = readFileSync(path, "utf8");
  await f.domain.stop();
  f.scope.workflow.unregisterParticipant(f.domain);
  f.scope.domainRegistry.unregister(f.domain);
  f.base.execution.stop();
  f.base.restore(data);

  const resumed = new RbtDomain();
  f.scope.domainRegistry.register(resumed);
  f.scope.workflow.registerParticipant(resumed);
  try {
    await resumed.start();
    await resumed.restore(data);
    await resumed.run();
    assert.equal(new RbtDomainProjector().project(resumed.recordObject.read()).executionPlatform, "android");
    await resumed.selectExecutionSource("android");
    await assert.rejects(resumed.selectExecutionSource("unity_editor"), /already selected android/);
    assert.ok((await f.base.execution.launch()).ok, "Semantic launch reuses the restored target");
    assert.deepEqual(f.operations.map((operation) => operation.operation), ["identify", "launch"]);
    assert.equal(readFileSync(path, "utf8"), original, "Restore and repeat choice do not append a selection");
  } finally {
    await resumed.stop();
    f.scope.workflow.unregisterParticipant(resumed);
    f.scope.domainRegistry.unregister(resumed);
  }
});

test("Source record decoding rejects invalid identity and projection rejects conflicting selections", async (t) => {
  const f = await fixture(t);
  await f.domain.selectExecutionSource("android");
  const records = f.domain.recordObject.read();
  assert.throws(() => decodeRbtRecords([{ ...records[0]!, payload: { platform: "windows" } }]), /execution platform/);
  const additional = decodeRbtRecords([{ ...records[0]!, seq: 2, payload: { platform: "unity_editor" } }]);
  assert.throws(() => new RbtDomainProjector().project([...records, ...additional]), /conflicting execution source/);
  const projected = new RbtDomainProjector().project(records);
  const selection = records[0]!;
  assert.equal(selection.kind, "execution-source");
  if (selection.kind === "execution-source") selection.payload.platform = "unity_editor";
  assert.equal(projected.executionPlatform, "android", "Record mutation is not a runtime mutation");
});

test("Restore neither guesses an unselected source nor falls back from a removed source", async (t) => {
  for (const selected of [false, true]) await t.test(selected ? "removed platform" : "before selection", async (t) => {
    const f = await fixture(t);
    if (selected) await f.domain.selectExecutionSource("android");
    const data = f.scope.workflow.snapshot()!;
    await f.domain.stop();
    f.scope.workflow.unregisterParticipant(f.domain);
    f.scope.domainRegistry.unregister(f.domain);
    f.base.execution.stop();
    f.base.restore(data);
    if (selected) writeFileSync(f.configPath, JSON.stringify({ executionSources: { unity_editor: { transport: "unity-pipeline" } } }));
    const resumed = new RbtDomain();
    f.scope.domainRegistry.register(resumed);
    f.scope.workflow.registerParticipant(resumed);
    try {
      await resumed.start();
      if (selected) {
        await assert.rejects(resumed.restore(data), /restored platform android/);
        assert.equal(resumed.recordObject.read().length, 1);
      } else {
        await resumed.restore(data);
        await resumed.run();
        assert.deepEqual(resumed.recordObject.read(), []);
      }
      const unconfigured = await f.base.execution.launch();
      assert.ok(!unconfigured.ok && unconfigured.code === "execution_not_configured");
      assert.equal(f.operations.length, 0);
      if (!selected) {
        await resumed.selectExecutionSource("android");
        assert.equal(resumed.recordObject.read().length, 1);
      }
    } finally {
      await resumed.stop();
      f.scope.workflow.unregisterParticipant(resumed);
      f.scope.domainRegistry.unregister(resumed);
    }
  });
});

test("Workflow completion clears configuration, the next Workflow can choose another platform, and history remains", async (t) => {
  const f = await fixture(t);
  await f.domain.selectExecutionSource("android");
  assert.ok((await f.base.execution.launch()).ok);
  assert.ok((await f.base.execution.shutdown()).ok);
  const oldPath = f.domain.recordObject.path;
  const original = readFileSync(oldPath, "utf8");
  await f.scope.workflow.advance("error");
  assert.equal(f.scope.workflow.snapshot(), undefined);
  const noConfiguration = await f.base.execution.launch();
  assert.ok(!noConfiguration.ok && noConfiguration.code === "execution_not_configured");
  await assert.rejects(f.domain.selectExecutionSource("unity_editor"), /Workflow is unavailable/);
  await f.scope.workflow.startWorkflow("second platform");
  assert.equal(f.scope.workflow.snapshot()!.workflowId, "workflow-002");
  assert.deepEqual(f.domain.recordObject.read(), []);
  await f.domain.selectExecutionSource("unity_editor");
  assert.ok((await f.base.execution.launch()).ok);
  assert.deepEqual(f.operations.at(-2)!.parameters, { transport: "unity-pipeline" });
  assert.equal(readFileSync(oldPath, "utf8"), original);
});

test("A failed selection append does not bind configuration or permit RBT execution", async (t) => {
  const f = await fixture(t);
  const path = f.domain.recordObject.path;
  const backup = path + ".test-backup";
  renameSync(path, backup);
  mkdirSync(path);
  try {
    const response = await f.domain.backend.handleDynamicToolCall(call({ platform: "android" }));
    assert.equal(response?.success, false);
    assert.match(response?.contentItems[0]?.text ?? "", /could not be recorded/);
    const result = await f.base.execution.launch();
    assert.ok(!result.ok && result.code === "execution_not_configured");
    assert.equal(f.operations.length, 0);
  } finally {
    rmSync(path, { recursive: true });
    renameSync(backup, path);
  }
  await f.domain.selectExecutionSource("android");
  assert.equal(f.domain.recordObject.read().length, 1);
});

function call(argumentsInput: unknown, phase = "execute"): ScoutDomainDynamicToolCall {
  const role = phase === "Synthesis" ? "coordinator" : phase === "review" ? "reviewer" : "executor";
  return {
    input: { threadId: `thread-${role}`, turnId: `turn-${role}`, callId: "select-source", namespace: "rbt_execution",
      tool: "SelectExecutionSource", arguments: argumentsInput },
    caller: { agentId: role, role, phase, threadId: `thread-${role}` },
  };
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-source-"));
  const configRoot = join(root, "assets", "scout", "config");
  mkdirSync(configRoot, { recursive: true });
  const configPath = join(configRoot, "rbt.config.json");
  writeFileSync(configPath, JSON.stringify({ executionSources: {
    unity_editor: { transport: "unity-pipeline" }, android: { transport: "adb", appId: "com.example.android" },
  } }));
  const eventBus = new InMemoryEventBus();
  const operations: ExecutionHandlerInvocation[] = [];
  const system = await ScoutExecutionSystem.start({
    async start() {},
    async invoke(invocation) {
      operations.push(structuredClone(invocation));
      return invocation.operation === "identify"
        ? { ok: true, value: { transport: invocation.parameters.transport ?? "unity-pipeline",
          platform: { type: invocation.parameters.transport === "adb" ? "android" : "unity_editor", version: "test" } } }
        : { ok: true };
    },
    async close() {},
  }, eventBus);
  const domain = new RbtDomain();
  const asset = buildWorkflow(process.cwd(), "rbt");
  const scope = await installTestRunScope(t, { runId: "source-test", scoutRoot: root,
    runRoot: join(root, "run"), domain, eventBus, executionSystem: system,
    runtimeGraph: new Graph(asset), workflowAsset: asset });
  t.after(() => system.dispose());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = scope.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(base instanceof BaseDomain);
  await domain.start();
  await domain.run();
  return { scope, domain, base, operations, configPath };
}
