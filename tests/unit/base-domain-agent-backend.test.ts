import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDynamicToolSpec } from "../../src/agent/tools/types.js";
import {
  BaseDomainAgentBackend,
  BaseDomainEvents,
  BaseDomainToolCallStore,
  type ScoutDomainDynamicToolCall,
} from "../../src/domain/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";
import { executionPlatformAgentTool } from "../../src/domain/domains/base/agent/tools/agent-tools.js";

test("BaseDomainAgentBackend invokes its constructed tool with the actual Phase and records completion", async (t) => {
  const scope = await installTestRunScope(t, { runId: "run-base-domain-agent-tools" });
  const store = new BaseDomainToolCallStore();
  const invocations: string[] = [];
  const observations: string[] = [];
  scope.eventBus.subscribe(BaseDomainEvents.agentToolCall.observed, (event) => {
    if (BaseDomainEvents.agentToolCall.observed.is(event)) observations.push(event.payload.phase);
  });
  const backend = new BaseDomainAgentBackend(store, {
    execute(call) {
      invocations.push(call.caller.phase);
      return success(call.caller.phase);
    },
  });
  for (const phase of ["execute", "review"]) {
    const invocation = call(phase, executionPlatformAgentTool);
    invocation.input.callId = "call-" + phase;
    assert.deepEqual(await backend.handleDynamicToolCall(invocation), success(phase));
  }
  assert.deepEqual(invocations, ["execute", "review"]);
  assert.deepEqual(store.list().map((entry) => entry.phase), ["execute", "review"]);
  assert.deepEqual(observations, ["execute", "review"]);
});

test("BaseDomainAgentBackend ignores other tool identities without execution or recording", async (t) => {
  await installTestRunScope(t, { runId: "run-base-domain-agent-tool-rejection" });
  const store = new BaseDomainToolCallStore();
  let invocationCount = 0;
  const backend = new BaseDomainAgentBackend(store, {
    execute() { invocationCount += 1; return success("executed"); },
  });
  for (const definition of [
    { ...executionPlatformAgentTool, name: "MissingTool" },
    { ...executionPlatformAgentTool, namespace: "other_namespace" },
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
  const error = new Error("Base tool failed");
  for (const [index, tool] of [
    { execute() { throw error; } },
    { async execute() { throw error; } },
  ].entries()) {
    const backend = new BaseDomainAgentBackend(store, tool);
    const invocation = call("review", executionPlatformAgentTool);
    invocation.input.callId = "call-error-" + index;
    const response = await backend.handleDynamicToolCall(invocation);
    assert.ok(response);
    assert.equal(response.success, false);
    assert.match(response.contentItems[0]?.text ?? "", /Base tool failed/);
    assert.deepEqual(store.list().at(-1)?.response, response);
  }
  assert.deepEqual(observed, ["call-error-0", "call-error-1"]);
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
