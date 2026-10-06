import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDynamicToolSpec } from "../../src/agent/tools/types.js";
import {
  BaseDomainAgentBackend,
  BaseDomain,
  BaseDomainEvents,
  BaseDomainToolCallStore,
  ScoutDomainId,
  type BaseDomainAgentToolCallObservedEvent,
  type ScoutDomainDynamicToolCall,
} from "../../src/domain/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";
import { buildExecutionPlatformDynamicTool } from "../../src/domain/domains/base/agent/tools/agent-tools.js";
import { ExecutionPlatformTool } from "../../src/domain/domains/base/agent/tools/execution-platform-tool.js";

test("BaseDomainAgentBackend invokes its constructed tool with the actual Phase and records completion", async (t) => {
  const scope = await installTestRunScope(t, { runId: "run-base-domain-agent-tools" });
  const store = new BaseDomainToolCallStore();
  store.start();
  t.after(() => store.stop());
  const invocations: string[] = [];
  const observations: string[] = [];
  scope.eventBus.subscribe(BaseDomainEvents.agentToolCall.observed, (event) => {
    if (BaseDomainEvents.agentToolCall.observed.is(event)) observations.push(event.payload.phase);
  });
  const instances: ExecutionPlatformTool[] = [];
  t.mock.method(ExecutionPlatformTool.prototype, "execute", async function (this: ExecutionPlatformTool, call: ScoutDomainDynamicToolCall) {
    instances.push(this);
    invocations.push(call.caller.phase);
    return success(call.caller.phase);
  });
  const backend = new BaseDomainAgentBackend();
  for (const phase of ["execute", "review"]) {
    const invocation = call(phase, buildExecutionPlatformDynamicTool());
    invocation.input.callId = "call-" + phase;
    assert.deepEqual(await backend.handleDynamicToolCall(invocation), success(phase));
  }
  assert.deepEqual(invocations, ["execute", "review"]);
  assert.strictEqual(instances[0], instances[1], "One Backend keeps one Tool across calls");
  assert.deepEqual(store.list().map((entry) => entry.phase), ["execute", "review"]);
  assert.deepEqual(observations, ["execute", "review"]);
  await new BaseDomainAgentBackend().handleDynamicToolCall(call("execute", buildExecutionPlatformDynamicTool()));
  assert.notStrictEqual(instances[0], instances[2], "Another Backend creates its own Tool");
});

test("BaseDomainAgentBackend ignores other tool identities without execution or recording", async (t) => {
  await installTestRunScope(t, { runId: "run-base-domain-agent-tool-rejection" });
  const store = new BaseDomainToolCallStore();
  store.start();
  t.after(() => store.stop());
  let invocationCount = 0;
  t.mock.method(ExecutionPlatformTool.prototype, "execute", async () => { invocationCount += 1; return success("executed"); });
  const backend = new BaseDomainAgentBackend();
  for (const definition of [
    { ...buildExecutionPlatformDynamicTool(), name: "MissingTool" },
    { ...buildExecutionPlatformDynamicTool(), namespace: "other_namespace" },
  ]) assert.equal(await backend.handleDynamicToolCall(call("review", definition)), undefined);
  assert.equal(invocationCount, 0);
  assert.deepEqual(store.list(), []);
});

test("BaseDomainAgentBackend records thrown and rejected tool failures", async (t) => {
  const scope = await installTestRunScope(t, { runId: "run-base-domain-tool-errors" });
  const observed: string[] = [];
  scope.eventBus.subscribe(BaseDomainEvents.agentToolCall.observed, (event) => {
    if (BaseDomainEvents.agentToolCall.observed.is(event)) observed.push(event.payload.callId);
  });
  const store = new BaseDomainToolCallStore();
  store.start();
  t.after(() => store.stop());
  const error = new Error("Base tool failed");
  for (const [index, tool] of [
    { execute() { throw error; } },
    { async execute() { throw error; } },
  ].entries()) {
    const execute = t.mock.method(ExecutionPlatformTool.prototype, "execute", tool.execute);
    const backend = new BaseDomainAgentBackend();
    const invocation = call("review", buildExecutionPlatformDynamicTool());
    invocation.input.callId = "call-error-" + index;
    const response = await backend.handleDynamicToolCall(invocation);
    assert.ok(response);
    assert.equal(response.success, false);
    assert.match(response.contentItems[0]?.text ?? "", /Base tool failed/);
    assert.deepEqual(store.list().at(-1)?.response, response);
    execute.mock.restore();
  }
  assert.deepEqual(observed, ["call-error-0", "call-error-1"]);
});

test("Base Backend constructs its own Spec using the tool declaration function", () => {
  const backend = new BaseDomainAgentBackend();
  const another = new BaseDomainAgentBackend();
  const spec = backend.toolDefinitions[0]!;
  const declaration = buildExecutionPlatformDynamicTool();
  assert.deepEqual(spec, declaration);
  assert.notStrictEqual(spec, declaration);
  assert.notStrictEqual(spec.inputSchema, another.toolDefinitions[0]!.inputSchema);
  assert.notStrictEqual(spec, another.toolDefinitions[0]);
  spec.description = "Changed only in this Backend";
  assert.deepEqual(another.toolDefinitions[0], declaration);
});

test("Base Domain owns event-driven Store subscriptions across start and stop", async (t) => {
  const scope = await installTestRunScope(t, { runId: "run-base-store-subscriptions" });
  const domain = scope.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(domain instanceof BaseDomain);
  const definition = buildExecutionPlatformDynamicTool();
  const observation: BaseDomainAgentToolCallObservedEvent = {
    callId: "call-event-only", agentId: "worker", role: "worker", phase: "execute",
    namespace: definition.namespace!, tool: definition.name,
    arguments: { operation: "launch" }, response: success("completed"),
    startedAt: "2026-10-06T00:00:00.000Z", completedAt: "2026-10-06T00:00:01.000Z",
  };
  const snapshot = structuredClone(observation);
  await scope.eventBus.publishAndWait(BaseDomainEvents.agentToolCall.observed, observation);
  assert.deepEqual(domain.toolCallStore.list(), [snapshot]);
  observation.response.contentItems[0]!.text = "Changed after publication";
  assert.deepEqual(domain.toolCallStore.list(), [snapshot]);

  // Duplicate start must not install another subscription, even if one delivery clears its history.
  domain.start();
  domain.toolCallStore.start();
  const stopClearing = scope.eventBus.subscribe(BaseDomainEvents.agentToolCall.observed, () => domain.toolCallStore.clear());
  await scope.eventBus.publishAndWait(BaseDomainEvents.agentToolCall.observed, observation);
  assert.deepEqual(domain.toolCallStore.list(), []);
  stopClearing();

  domain.stop();
  await scope.eventBus.publishAndWait(BaseDomainEvents.agentToolCall.observed, observation);
  assert.deepEqual(domain.toolCallStore.list(), []);
  domain.start();
  await scope.eventBus.publishAndWait(BaseDomainEvents.agentToolCall.observed, observation);
  assert.deepEqual(domain.toolCallStore.list(), [observation]);
});

test("Base Store restores detached history without publishing a second completion", async (t) => {
  const scope = await installTestRunScope(t, { runId: "run-base-store-restoration" });
  const domain = scope.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(domain instanceof BaseDomain);
  t.mock.method(ExecutionPlatformTool.prototype, "execute", async () => success("completed"));
  const backend = new BaseDomainAgentBackend();
  const observations: string[] = [];
  scope.eventBus.subscribe(BaseDomainEvents.agentToolCall.observed, (event) => {
    if (BaseDomainEvents.agentToolCall.observed.is(event)) observations.push(event.payload.callId);
  });
  await backend.handleDynamicToolCall(call("execute", buildExecutionPlatformDynamicTool()));
  const previous = domain.toolCallStore.list();
  assert.equal(previous.length, 1);
  domain.toolCallStore.clear();
  domain.restore(scope.workflow.snapshot()!);
  assert.deepEqual(domain.toolCallStore.list(), previous);
  assert.deepEqual(observations, ["call-ExecutionPlatform"]);

  domain.toolCallStore.clear();
  await backend.handleDynamicToolCall(call("review", buildExecutionPlatformDynamicTool()));
  assert.equal(domain.toolCallStore.list()[0]?.phase, "review", "Workflow clearing retains the Store subscription.");
});

function call(phase: string, definition: AgentDynamicToolSpec): ScoutDomainDynamicToolCall {
  return {
    input: {
      threadId: "thread-base-tool",
      turnId: "turn-base-tool",
      callId: `call-${definition.name}`,
      namespace: definition.namespace ?? null,
      tool: definition.name,
      arguments: {},
    },
    caller: {
      agentId: "worker",
      role: "worker",
      phase,
      threadId: "thread-base-tool",
    },
  };
}

function success(value: string) {
  return {
    success: true,
    contentItems: [{ type: "inputText" as const, text: value }],
  };
}
