import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_TASK_RESULT_TOOL_NAMESPACE,
  AGENT_USER_INPUT_TOOL_NAMESPACE,
  COORDINATOR_TOOL_NAMESPACE,
  buildAgentToolDynamicTool,
  buildRequestUserInputDynamicTool,
  buildTaskResultDynamicTool,
  parseCoordinatorDynamicToolCall,
  parseRequestUserInputDynamicToolCall,
  parseTaskResultDynamicToolCall,
} from "../../src/agent/tools.js";
import { ScoutAgentRoles } from "../../src/agent/types.js";

test("agent dynamic tool specs expose stable namespaces and required fields", () => {
  const agentTool = buildAgentToolDynamicTool();
  const userInputTool = buildRequestUserInputDynamicTool();
  const taskResultTool = buildTaskResultDynamicTool();

  assert.equal(agentTool.namespace, COORDINATOR_TOOL_NAMESPACE);
  assert.equal(userInputTool.namespace, AGENT_USER_INPUT_TOOL_NAMESPACE);
  assert.equal(taskResultTool.namespace, AGENT_TASK_RESULT_TOOL_NAMESPACE);
  assert.deepEqual(readRequired(agentTool.inputSchema), ["description", "subagent_type", "prompt"]);
  assert.deepEqual(readRequired(userInputTool.inputSchema), ["question"]);
  assert.deepEqual(readRequired(taskResultTool.inputSchema), ["status", "summary"]);
  assert.deepEqual(readEnumProperty(agentTool.inputSchema, "subagent_type"), [
    ScoutAgentRoles.Researcher,
    ScoutAgentRoles.Verifier,
    ScoutAgentRoles.Validator,
  ]);
});

test("agent tool parsers preserve typed payloads", () => {
  assert.deepEqual(parseCoordinatorDynamicToolCall("SendMessage", {
    to: "researcher",
    message: "继续验证",
  }), {
    tool: "SendMessage",
    to: "researcher",
    message: "继续验证",
  });
  assert.deepEqual(parseRequestUserInputDynamicToolCall("RequestUserInput", {
    kind: "prompt_required",
    question: "选 A 还是 B?",
    options: ["A", "B"],
  }), {
    tool: "RequestUserInput",
    kind: "prompt_required",
    question: "选 A 还是 B?",
    options: ["A", "B"],
  });
  assert.deepEqual(parseTaskResultDynamicToolCall("TaskResult", {
    status: "insufficient_evidence",
    summary: "证据不足",
    evidence_refs: ["evidence://1"],
  }), {
    tool: "TaskResult",
    status: "insufficient_evidence",
    summary: "证据不足",
    evidence_refs: ["evidence://1"],
  });
});

test("agent tool parsers reject non-object arguments", () => {
  assert.throws(() => parseCoordinatorDynamicToolCall("AgentTool", null));
  assert.throws(() => parseRequestUserInputDynamicToolCall("RequestUserInput", []));
  assert.throws(() => parseTaskResultDynamicToolCall("TaskResult", "bad"));
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
