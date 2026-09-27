import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDynamicToolSpec } from "../../src/agent/tools/types.js";
import {
  BaseDomainAgentBackend,
  BaseDomainToolCallStore,
  type ScoutDomainDynamicToolCall,
} from "../../src/domain/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("BaseDomainAgentBackend registers and invokes multiple tools by Phase", async (t) => {
  installTestRunScope(t, { runId: "run-base-domain-agent-tools" });
  const store = new BaseDomainToolCallStore();
  const invoked: string[] = [];
  const first = toolSpec("base_first", "FirstTool");
  const second = toolSpec("base_second", "SecondTool");
  const firstRegistration = {
    definition: first,
    tool: {
      execute(call: ScoutDomainDynamicToolCall) {
        invoked.push(call.input.tool);
        return success("first");
      },
    },
  };
  const duplicateFirstRegistration = {
    definition: structuredClone(first),
    tool: firstRegistration.tool,
  };
  const secondRegistration = {
    definition: second,
    tool: {
      execute(call: ScoutDomainDynamicToolCall) {
        invoked.push(call.input.tool);
        return success("second");
      },
    },
  };
  const backend = new BaseDomainAgentBackend(store);

  backend.register("execute", firstRegistration);
  backend.register("review", firstRegistration);
  backend.register("review", duplicateFirstRegistration);
  backend.register("review", secondRegistration);

  assert.deepEqual(backend.dynamicToolsForPhase("execute"), [first]);
  assert.deepEqual(backend.dynamicToolsForPhase("review"), [first, second]);
  const exposed = backend.dynamicToolsForPhase("review");
  const exposedSchema = exposed[0]!.inputSchema;
  assert.ok(exposedSchema && typeof exposedSchema === "object" && !Array.isArray(exposedSchema));
  exposedSchema.properties = { mutated: { type: "string" } };
  assert.deepEqual(backend.dynamicToolsForPhase("review"), [first, second]);

  const result = await backend.handleDynamicToolCall(call("review", second));

  assert.deepEqual(result, success("second"));
  assert.deepEqual(invoked, ["SecondTool"]);
  assert.deepEqual(store.list().map((entry) => entry.tool), ["SecondTool"]);

  backend.unregister("review", duplicateFirstRegistration);
  assert.deepEqual(backend.dynamicToolsForPhase("review"), [first, second]);
  backend.unregister("review", firstRegistration);
  assert.deepEqual(backend.dynamicToolsForPhase("review"), [second]);
  assert.deepEqual(backend.dynamicToolsForPhase("execute"), [first]);
  assert.throws(() => backend.unregister("review", firstRegistration), /is not registered/);
});

test("BaseDomainAgentBackend rejects conflicting and unregistered Phase tools", async (t) => {
  installTestRunScope(t, { runId: "run-base-domain-agent-tool-rejection" });
  const installed = toolSpec("base_installed", "InstalledTool");
  const missing = toolSpec("base_missing", "MissingTool");
  let invocationCount = 0;
  const registration = {
    definition: installed,
    tool: {
      execute() {
        invocationCount += 1;
        return success("installed");
      },
    },
  };
  const backend = new BaseDomainAgentBackend(new BaseDomainToolCallStore());
  backend.register("execute", registration);

  assert.throws(
    () => backend.register("execute", {
      definition: structuredClone(installed),
      tool: { execute: () => success("conflict") },
    }),
    /conflicts with its existing registration for Phase execute/,
  );
  const changedDefinition = {
    definition: { ...installed, inputSchema: { type: "string" } },
    tool: registration.tool,
  };
  assert.throws(() => backend.register("execute", changedDefinition), /conflicts/);
  assert.throws(() => backend.unregister("execute", changedDefinition), /is not registered/);
  const denied = await backend.handleDynamicToolCall(call("review", installed));
  const unknown = await backend.handleDynamicToolCall(call("review", missing));

  assert.equal(denied?.success, false);
  assert.match(denied?.contentItems[0]?.text ?? "", /InstalledTool is not registered for Phase review/);
  assert.equal(unknown, undefined);
  assert.equal(invocationCount, 0);
  assert.deepEqual(
    await backend.handleDynamicToolCall(call("execute", installed)),
    success("installed"),
  );
  assert.equal(invocationCount, 1);
  backend.unregister("execute", registration);
  assert.deepEqual(backend.dynamicToolsForPhase("execute"), []);
});

function toolSpec(namespace: string, name: string): AgentDynamicToolSpec {
  return {
    guidanceSkill: `tool-${namespace}`,
    namespace,
    name,
    description: `${name} test tool.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  };
}

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
