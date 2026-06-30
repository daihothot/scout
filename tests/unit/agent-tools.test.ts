import test from "node:test";
import assert from "node:assert/strict";
import {
  SYSTEM_TOOL_NAMESPACE,
  buildAgentToolDynamicTool,
  buildRequestHumanInputDynamicTool,
  buildSendMessageDynamicTool,
  parseSystemDynamicToolCall,
} from "../../src/agent/tools/system-tools.js";
import { ScoutAgentRoles } from "../../src/agent/model/types.js";

test("agent dynamic tool specs expose stable namespaces and required fields", () => {
  const agentTool = buildAgentToolDynamicTool();
  const sendMessageTool = buildSendMessageDynamicTool();
  const humanInputTool = buildRequestHumanInputDynamicTool();

  assert.equal(agentTool.namespace, SYSTEM_TOOL_NAMESPACE);
  assert.equal(sendMessageTool.namespace, SYSTEM_TOOL_NAMESPACE);
  assert.equal(humanInputTool.namespace, SYSTEM_TOOL_NAMESPACE);
  assert.deepEqual(readRequired(agentTool.inputSchema), ["description", "subagent_type", "prompt"]);
  assert.deepEqual(readRequired(sendMessageTool.inputSchema), ["to", "message"]);
  assert.deepEqual(readRequired(humanInputTool.inputSchema), ["question"]);
  assert.deepEqual(readEnumProperty(agentTool.inputSchema, "subagent_type"), [
    ScoutAgentRoles.Researcher,
    ScoutAgentRoles.Verifier,
    ScoutAgentRoles.Validator,
  ]);
});

test("agent tool parsers preserve typed payloads", () => {
  assert.deepEqual(parseSystemDynamicToolCall("SendMessage", {
    to: "researcher",
    message: "继续验证",
  }), {
    tool: "SendMessage",
    to: "researcher",
    message: "继续验证",
  });
  assert.deepEqual(parseSystemDynamicToolCall("RequestHumanInput", {
    kind: "prompt_required",
    question: "选 A 还是 B?",
    options: ["A", "B"],
  }), {
    tool: "RequestHumanInput",
    kind: "prompt_required",
    question: "选 A 还是 B?",
    options: ["A", "B"],
  });
});

test("agent tool parsers reject non-object arguments", () => {
  assert.throws(() => parseSystemDynamicToolCall("AgentTool", null));
  assert.throws(() => parseSystemDynamicToolCall("RequestHumanInput", []));
});

function readRequired(schema: unknown): string[] {
  const object = readObject(schema);
  return Array.isArray(object.required) ? object.required.filter((item): item is string => typeof item === "string") : [];
}

function readEnumProperty(schema: unknown, key: string): string[] {
  const object = readObject(schema);
  const properties = readObject(object.properties);
  const property = readObject(properties[key]);
  return Array.isArray(property.enum) ? property.enum.filter((item): item is string => typeof item === "string") : [];
}

function readObject(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}
