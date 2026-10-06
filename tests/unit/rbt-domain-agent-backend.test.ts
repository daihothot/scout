import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDynamicToolSpec } from "../../src/agent/tools/types.js";
import {
  DomainEvents,
  ScoutDomainId,
  type DomainAgentToolCallObservedEvent,
  type ScoutDomainDynamicToolCall,
} from "../../src/domain/index.js";
import { RbtDomain, RbtDomainAgentBackend } from "../../src/domain/domains/rbt/index.js";
import { JarvisBehaviorTool } from "../../src/domain/domains/rbt/agent/tools/jarvis-behavior/jarvis-behavior-tool.js";
import { SearchExecutionPackTool } from "../../src/domain/domains/rbt/agent/tools/search-execution-pack/search-execution-pack-tool.js";
import { SelectExecutionSourceTool } from "../../src/domain/domains/rbt/agent/tools/select-execution-source/select-execution-source-tool.js";
import { buildJarvisBehaviorDynamicTool, buildSearchExecutionPackDynamicTool, buildSelectExecutionSourceDynamicTool } from "../../src/domain/domains/rbt/agent/tools/agent-tools.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("RbtDomainAgentBackend invokes the same constructed tool with the actual call Phase", async (t) => {
  const scope = await installTestRunScope(t, { runId: "rbt-backend-phase-tools" });
  const observations: DomainAgentToolCallObservedEvent[] = [];
  scope.eventBus.subscribe(DomainEvents.agentToolCall.observed, (event) => {
    if (DomainEvents.agentToolCall.observed.is(event)) observations.push(event.payload);
  });
  const invocations: string[] = [];
  const instances: JarvisBehaviorTool[] = [];
  t.mock.method(JarvisBehaviorTool.prototype, "execute", async function (this: JarvisBehaviorTool, call: ScoutDomainDynamicToolCall) {
    instances.push(this);
    invocations.push(call.caller.phase);
    return success(call.caller.phase);
  });
  const backend = new RbtDomainAgentBackend();
  for (const phase of ["execute", "review"]) {
    assert.deepEqual(await backend.handleDynamicToolCall(call(phase, toolSpec())), success(phase));
  }
  assert.deepEqual(invocations, ["execute", "review"]);
  assert.strictEqual(instances[0], instances[1], "One Backend keeps one Tool across calls");
  assert.deepEqual(observations.map((event) => ({ domainId: event.domainId, phase: event.phase, response: event.response })), [
    { domainId: ScoutDomainId.Rbt, phase: "execute", response: success("execute") },
    { domainId: ScoutDomainId.Rbt, phase: "review", response: success("review") },
  ]);
  await new RbtDomainAgentBackend().handleDynamicToolCall(call("execute", toolSpec()));
  assert.notStrictEqual(instances[0], instances[2], "Another Backend creates its own Tool");
});

test("RbtDomainAgentBackend routes distinct tool identities and ignores unrelated namespaces", async (t) => {
  const scope = await installTestRunScope(t, { runId: "rbt-backend-tool-identities" });
  const observations: DomainAgentToolCallObservedEvent[] = [];
  scope.eventBus.subscribe(DomainEvents.agentToolCall.observed, (event) => {
    if (DomainEvents.agentToolCall.observed.is(event)) observations.push(event.payload);
  });
  t.mock.method(JarvisBehaviorTool.prototype, "execute", async () => success("behavior"));
  t.mock.method(SearchExecutionPackTool.prototype, "execute", async () => success("lookup"));
  t.mock.method(SelectExecutionSourceTool.prototype, "execute", async () => success("selection"));
  const backend = new RbtDomainAgentBackend();
  assert.equal(await backend.handleDynamicToolCall(call("execute", { ...toolSpec(), namespace: "other_behavior" })), undefined);
  assert.equal(await backend.handleDynamicToolCall(call("execute", { ...toolSpec(), name: "MissingTool" })), undefined);
  assert.deepEqual(observations, []);
  assert.deepEqual(await backend.handleDynamicToolCall(call("execute", toolSpec())), success("behavior"));
  assert.deepEqual(await backend.handleDynamicToolCall(call("execute", buildSearchExecutionPackDynamicTool())), success("lookup"));
  assert.deepEqual(await backend.handleDynamicToolCall(call("execute", buildSelectExecutionSourceDynamicTool())), success("selection"));
  assert.equal(observations.length, 3);
});

test("RbtDomainAgentBackend converts thrown and rejected tool errors into observed failures", async (t) => {
  const scope = await installTestRunScope(t, { runId: "rbt-backend-tool-errors" });
  const observations: DomainAgentToolCallObservedEvent[] = [];
  scope.eventBus.subscribe(DomainEvents.agentToolCall.observed, (event) => {
    if (DomainEvents.agentToolCall.observed.is(event)) observations.push(event.payload);
  });
  const definition = toolSpec();
  const error = new Error("RBT test tool failed");
  const tools = [
    { execute() { throw error; } },
    { async execute() { throw error; } },
  ];
  for (const [index, tool] of tools.entries()) {
    const execute = t.mock.method(JarvisBehaviorTool.prototype, "execute", tool.execute);
    const backend = new RbtDomainAgentBackend();
    const invocation = call("execute", definition);
    invocation.input.callId = `call-error-${index}`;
    const response = await backend.handleDynamicToolCall(invocation);

    assert.ok(response);
    assert.equal(response.success, false);
    assert.match(response.contentItems[0]?.text ?? "", /RBT test tool failed/);
    assert.equal(observations.length, index + 1);
    assert.equal(observations[index]!.callId, invocation.input.callId);
    assert.deepEqual(observations[index]!.response, response);
    execute.mock.restore();
  }
});

test("RbtDomain exposes its backend for invocation with one detached completion", async (t) => {
  const domain = new RbtDomain();
  const scope = await installTestRunScope(t, { runId: "rbt-backend-domain-access", domain });
  const observations: DomainAgentToolCallObservedEvent[] = [];
  const occurredAt: string[] = [];
  scope.eventBus.subscribe(DomainEvents.agentToolCall.observed, (event) => {
    if (!DomainEvents.agentToolCall.observed.is(event)) return;
    observations.push(event.payload);
    occurredAt.push(event.occurredAt);
  });
  const definition = toolSpec();
  const output = success("completed");
  let toolCompletedAt = 0;
  t.mock.method(JarvisBehaviorTool.prototype, "execute", async () => {
    await Promise.resolve();
    toolCompletedAt = Date.now();
    return output;
  });
  const invocation = call("execute", definition);
  const argumentsInput = { query: "original" };
  invocation.input.arguments = argumentsInput;
  const beforeCall = Date.now();
  const response = await domain.backend.handleDynamicToolCall(invocation);

  assert.strictEqual(response, output);
  assert.ok(response);
  assert.equal(observations.length, 1);
  const observed = observations[0]!;
  assert.deepEqual(observed, {
    domainId: ScoutDomainId.Rbt,
    callId: invocation.input.callId,
    threadId: invocation.caller.threadId,
    agentId: invocation.caller.agentId,
    role: invocation.caller.role,
    phase: invocation.caller.phase,
    namespace: definition.namespace,
    tool: definition.name,
    arguments: { query: "original" },
    response: success("completed"),
    startedAt: observed.startedAt,
    completedAt: observed.completedAt,
  });
  assert.ok(Date.parse(observed.startedAt) >= beforeCall);
  assert.ok(Date.parse(observed.startedAt) <= toolCompletedAt);
  assert.ok(Date.parse(observed.completedAt) >= toolCompletedAt);
  assert.equal(occurredAt[0], observed.completedAt);

  argumentsInput.query = "changed";
  response.contentItems[0]!.text = "changed";
  assert.deepEqual(observed.arguments, { query: "original" });
  assert.deepEqual(observed.response, success("completed"));
});

test("RBT Backend constructs independent Specs using tool declaration functions", () => {
  const backend = new RbtDomainAgentBackend();
  const another = new RbtDomainAgentBackend();
  const declarations = [buildJarvisBehaviorDynamicTool(), buildSearchExecutionPackDynamicTool(), buildSelectExecutionSourceDynamicTool()];
  assert.deepEqual(backend.toolDefinitions, declarations);
  for (const [index, declaration] of declarations.entries()) {
    const spec = backend.toolDefinitions[index]!;
    assert.notStrictEqual(spec, declaration);
    assert.notStrictEqual(spec.inputSchema, another.toolDefinitions[index]!.inputSchema);
    assert.notStrictEqual(spec, another.toolDefinitions[index]);
    spec.description = "Changed only in this Backend";
    assert.deepEqual(another.toolDefinitions[index], declaration);
  }
});

function toolSpec(): AgentDynamicToolSpec {
  return {
    guidanceSkill: "tool-rbt-behavior",
    namespace: "rbt_behavior",
    name: "JarvisBehavior",
    description: "RBT behavior test tool.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  };
}

function call(
  phase: string,
  definition: AgentDynamicToolSpec,
): ScoutDomainDynamicToolCall {
  return {
    input: {
      threadId: `thread-${phase}`,
      turnId: `turn-${phase}`,
      callId: `call-${phase}`,
      namespace: definition.namespace ?? null,
      tool: definition.name,
      arguments: {},
    },
    caller: {
      agentId: "worker",
      role: "worker",
      phase,
      threadId: `thread-${phase}`,
    },
  };
}

function success(value: string) {
  return {
    success: true,
    contentItems: [{ type: "inputText" as const, text: value }],
  };
}
