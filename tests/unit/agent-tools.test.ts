import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
  AGENT_HUMAN_INPUT_TOOL_NAMESPACE,
  AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
  AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
  buildAssignTaskDynamicTool,
  buildRequestHumanInputDynamicTool,
  buildSendMessageDynamicTool,
  buildSubmitTaskDynamicTool,
  parseAgentDynamicToolCall,
} from "../../src/agent/tools/agent-tools.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";

test("agent dynamic tool specs expose stable namespaces and required fields", () => {
  const assignTaskTool = buildAssignTaskDynamicTool();
  const sendMessageTool = buildSendMessageDynamicTool();
  const humanInputTool = buildRequestHumanInputDynamicTool();
  const submitTaskTool = buildSubmitTaskDynamicTool();

  assert.equal(assignTaskTool.namespace, AGENT_ASSIGN_TASK_TOOL_NAMESPACE);
  assert.equal(sendMessageTool.namespace, AGENT_SEND_MESSAGE_TOOL_NAMESPACE);
  assert.equal(humanInputTool.namespace, AGENT_HUMAN_INPUT_TOOL_NAMESPACE);
  assert.equal(submitTaskTool.namespace, AGENT_SUBMIT_TASK_TOOL_NAMESPACE);
  assert.deepEqual(readRequired(assignTaskTool.inputSchema), ["description", "subagent_type", "prompt"]);
  assert.deepEqual(readRequired(sendMessageTool.inputSchema), ["to", "message"]);
  assert.deepEqual(readRequired(humanInputTool.inputSchema), ["question"]);
  assert.deepEqual(readRequired(submitTaskTool.inputSchema), ["status", "summary"]);
  assert.deepEqual(readEnumProperty(sendMessageTool.inputSchema, "type"), ["message", "human_response"]);
  assert.deepEqual(readEnumProperty(submitTaskTool.inputSchema, "status"), ["complete", "blocked", "failed"]);
  assert.deepEqual(readEnumProperty(assignTaskTool.inputSchema, "subagent_type"), [
    ScoutAgentRoles.Researcher,
    ScoutAgentRoles.Verifier,
    ScoutAgentRoles.Validator,
  ]);
});

test("agent tool parsers preserve typed payloads", () => {
  assert.deepEqual(parseAgentDynamicToolCall("SendMessage", {
    to: "researcher",
    type: "message",
    message: "继续验证",
  }), {
    tool: "SendMessage",
    to: "researcher",
    type: "message",
    message: "继续验证",
  });
  assert.deepEqual(parseAgentDynamicToolCall("RequestHumanInput", {
    kind: "prompt_required",
    question: "选 A 还是 B?",
    options: ["A", "B"],
  }), {
    tool: "RequestHumanInput",
    kind: "prompt_required",
    question: "选 A 还是 B?",
    options: ["A", "B"],
  });
  assert.deepEqual(parseAgentDynamicToolCall("SubmitTask", {
    status: "complete",
    summary: "验证完成。",
  }), {
    tool: "SubmitTask",
    status: "complete",
    summary: "验证完成。",
  });
});

test("agent tool parsers reject non-object arguments", () => {
  assert.throws(() => parseAgentDynamicToolCall("AssignTask", null));
  assert.throws(() => parseAgentDynamicToolCall("RequestHumanInput", []));
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
