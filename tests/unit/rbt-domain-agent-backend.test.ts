import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDynamicToolSpec } from "../../src/agent/tools/types.js";
import {
  DomainEvents,
  ScoutDomainId,
  type DomainAgentToolCallObservedEvent,
  type DomainAgentToolRegistration,
  type ScoutDomainDynamicToolCall,
} from "../../src/domain/index.js";
import { RbtDomain, RbtDomainAgentBackend } from "../../src/domain/domains/rbt/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("RbtDomainAgentBackend invokes the constructed tool registered for each Phase", async (t) => {
  const scope = await installTestRunScope(t, { runId: "rbt-backend-phase-tools" });
  const observations: DomainAgentToolCallObservedEvent[] = [];
  scope.eventBus.subscribe(DomainEvents.agentToolCall.observed, (event) => {
    if (DomainEvents.agentToolCall.observed.is(event)) observations.push(event.payload);
  });
  const definition = toolSpec();
  const invocations: string[] = [];
  const executeRegistration: DomainAgentToolRegistration = {
    definition,
    tool: {
      execute(call) {
        invocations.push(`execute:${call.caller.phase}`);
        return success("execute");
      },
    },
  };
  const reviewRegistration: DomainAgentToolRegistration = {
    definition,
    tool: {
      execute(call) {
        invocations.push(`review:${call.caller.phase}`);
        return success("review");
      },
    },
  };
  const backend = new RbtDomainAgentBackend();

  backend.register("execute", executeRegistration);
  backend.register("review", reviewRegistration);

  assert.deepEqual(backend.dynamicToolsForPhase("execute"), [definition]);
  assert.deepEqual(backend.dynamicToolsForPhase("review"), [definition]);
  assert.deepEqual(
    await backend.handleDynamicToolCall(call("execute", definition)),
    success("execute"),
  );
  assert.deepEqual(
    await backend.handleDynamicToolCall(call("review", definition)),
    success("review"),
  );
  assert.deepEqual(invocations, ["execute:execute", "review:review"]);

  backend.unregister("review", reviewRegistration);
  const denied = await backend.handleDynamicToolCall(call("review", definition));

  assert.equal(denied.success, false);
  assert.match(
    denied.contentItems[0]?.text ?? "",
    /rbt_behavior\/JarvisBehavior is not registered for Phase review/,
  );
  assert.deepEqual(backend.dynamicToolsForPhase("review"), []);
  assert.deepEqual(invocations, ["execute:execute", "review:review"]);
  assert.deepEqual(backend.dynamicToolsForPhase("execute"), [definition]);
  assert.deepEqual(observations.map((event) => ({
    domainId: event.domainId,
    phase: event.phase,
    response: event.response,
  })), [
    { domainId: ScoutDomainId.Rbt, phase: "execute", response: success("execute") },
    { domainId: ScoutDomainId.Rbt, phase: "review", response: success("review") },
    { domainId: ScoutDomainId.Rbt, phase: "review", response: denied },
  ]);
});

test("RbtDomainAgentBackend preserves registrations after conflicting changes", async (t) => {
  await installTestRunScope(t, { runId: "rbt-backend-registration-conflicts" });
  const definition = toolSpec();
  const registration = { definition, tool: { execute: () => success("original") } };
  const backend = new RbtDomainAgentBackend();
  backend.register("execute", registration);
  backend.register("execute", {
    definition: structuredClone(definition),
    tool: registration.tool,
  });

  const wrongTool = { definition, tool: { execute: () => success("wrong") } };
  const wrongDefinition = {
    definition: { ...definition, inputSchema: { type: "string" } },
    tool: registration.tool,
  };
  for (const conflicting of [wrongTool, wrongDefinition]) {
    assert.throws(() => backend.register("execute", conflicting), /conflicts/);
    assert.throws(() => backend.unregister("execute", conflicting), /is not registered/);
  }

  backend.unregister("execute", registration);
  assert.deepEqual(backend.dynamicToolsForPhase("execute"), [definition]);
  assert.deepEqual(
    await backend.handleDynamicToolCall(call("execute", definition)),
    success("original"),
  );
  backend.unregister("execute", registration);
  assert.deepEqual(backend.dynamicToolsForPhase("execute"), []);
  assert.throws(() => backend.unregister("execute", registration), /is not registered/);
});

test("RbtDomainAgentBackend isolates namespaces and definition snapshots", async (t) => {
  await installTestRunScope(t, { runId: "rbt-backend-definition-snapshots" });
  const definition = toolSpec();
  const expected = structuredClone(definition);
  const otherDefinition = { ...toolSpec(), namespace: "other_behavior" };
  const backend = new RbtDomainAgentBackend();
  backend.register("execute", { definition, tool: { execute: () => success("first") } });
  backend.register("execute", {
    definition: otherDefinition,
    tool: { execute: () => success("second") },
  });

  const inputSchema = definition.inputSchema;
  assert.ok(inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema));
  inputSchema.properties = { mutated: { type: "string" } };
  const exposed = backend.dynamicToolsForPhase("execute");
  exposed[0]!.name = "ChangedTool";
  const exposedSchema = exposed[0]!.inputSchema;
  assert.ok(exposedSchema && typeof exposedSchema === "object" && !Array.isArray(exposedSchema));
  exposedSchema.properties = { external: { type: "number" } };
  assert.deepEqual(backend.dynamicToolsForPhase("execute"), [expected, otherDefinition]);
  assert.deepEqual(
    await backend.handleDynamicToolCall(call("execute", expected)),
    success("first"),
  );
  assert.deepEqual(
    await backend.handleDynamicToolCall(call("execute", otherDefinition)),
    success("second"),
  );
});

test("RbtDomainAgentBackend converts thrown and rejected tool errors into observed failures", async (t) => {
  const scope = await installTestRunScope(t, { runId: "rbt-backend-tool-errors" });
  const observations: DomainAgentToolCallObservedEvent[] = [];
  scope.eventBus.subscribe(DomainEvents.agentToolCall.observed, (event) => {
    if (DomainEvents.agentToolCall.observed.is(event)) observations.push(event.payload);
  });
  const definition = toolSpec();
  const error = new Error("RBT test tool failed");
  const backend = new RbtDomainAgentBackend();
  const tools = [
    { execute() { throw error; } },
    { async execute() { throw error; } },
  ];
  for (const [index, tool] of tools.entries()) {
    const registration = { definition, tool };
    backend.register("execute", registration);
    const invocation = call("execute", definition);
    invocation.input.callId = `call-error-${index}`;
    const response = await backend.handleDynamicToolCall(invocation);

    assert.equal(response.success, false);
    assert.match(response.contentItems[0]?.text ?? "", /RBT test tool failed/);
    assert.equal(observations.length, index + 1);
    assert.equal(observations[index]!.callId, invocation.input.callId);
    assert.deepEqual(observations[index]!.response, response);
    backend.unregister("execute", registration);
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
  domain.backend.register("execute", {
    definition,
    tool: {
      async execute() {
        await Promise.resolve();
        toolCompletedAt = Date.now();
        return output;
      },
    },
  });
  const invocation = call("execute", definition);
  const argumentsInput = { query: "original" };
  invocation.input.arguments = argumentsInput;
  const beforeCall = Date.now();
  const response = await domain.backend.handleDynamicToolCall(invocation);

  assert.strictEqual(response, output);
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
