import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_ARCHIVE_TASK_TOOL_NAMESPACE,
  AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
  AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
  AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
  buildArchiveTaskDynamicTool,
  buildAssignTaskDynamicTool,
  buildSendMessageDynamicTool,
  buildSubmitTaskDynamicTool,
  parseAgentDynamicToolCall,
  readSendMessageAttachment,
} from "../../src/agent/tools/agent-tools.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";

test("agent dynamic tool specs expose stable namespaces and required fields", () => {
  const assignTaskTool = buildAssignTaskDynamicTool();
  const sendMessageTool = buildSendMessageDynamicTool();
  const submitTaskTool = buildSubmitTaskDynamicTool();
  const archiveTaskTool = buildArchiveTaskDynamicTool();

  assert.equal(assignTaskTool.namespace, AGENT_ASSIGN_TASK_TOOL_NAMESPACE);
  assert.equal(sendMessageTool.namespace, AGENT_SEND_MESSAGE_TOOL_NAMESPACE);
  assert.equal(submitTaskTool.namespace, AGENT_SUBMIT_TASK_TOOL_NAMESPACE);
  assert.equal(archiveTaskTool.namespace, AGENT_ARCHIVE_TASK_TOOL_NAMESPACE);
  assert.deepEqual(readRequired(assignTaskTool.inputSchema), ["description", "subagent_type", "prompt"]);
  assert.deepEqual(readRequired(sendMessageTool.inputSchema), ["to", "message"]);
  assert.deepEqual(readRequired(submitTaskTool.inputSchema), ["outcome"]);
  assert.deepEqual(readRequired(archiveTaskTool.inputSchema), ["task_id"]);
  assert.equal(hasSchemaProperty(sendMessageTool.inputSchema, "type"), false);
  assert.deepEqual(readEnumProperty(assignTaskTool.inputSchema, "subagent_type"), [
    ScoutAgentRoles.Researcher,
    ScoutAgentRoles.Verifier,
    ScoutAgentRoles.Validator,
  ]);
});

test("agent tool parser validates and normalizes each tool payload", () => {
  assert.deepEqual(parseAgentDynamicToolCall("AssignTask", {
    agent_id: " researcher ",
    description: " Research BDD ",
    subagent_type: ScoutAgentRoles.Researcher,
    prompt: " Inspect current evidence ",
  }), {
    tool: "AssignTask",
    agent_id: "researcher",
    description: "Research BDD",
    subagent_type: ScoutAgentRoles.Researcher,
    prompt: "Inspect current evidence",
  });
  assert.deepEqual(parseAgentDynamicToolCall("SendMessage", {
    to: " researcher ",
    message: " <message>\n继续验证\n</message> ",
  }), {
    tool: "SendMessage",
    to: "researcher",
    message: "<message>\n继续验证\n</message>",
  });
  assert.deepEqual(parseAgentDynamicToolCall("SubmitTask", {
    outcome: " ## Outcome\n\nartifact: research/index.md ",
  }), {
    tool: "SubmitTask",
    outcome: "## Outcome\n\nartifact: research/index.md",
  });
  assert.deepEqual(parseAgentDynamicToolCall("ArchiveTask", {
    task_id: " task-1 ",
  }), {
    tool: "ArchiveTask",
    task_id: "task-1",
  });
});

test("agent tool parser rejects malformed tool payloads", () => {
  assert.throws(() => parseAgentDynamicToolCall("AssignTask", null));
  assert.throws(() => parseAgentDynamicToolCall("SendMessage", []));
  assert.throws(() => parseAgentDynamicToolCall("SubmitTask", { outcome: " " }), /SubmitTask outcome/);
  assert.throws(() => parseAgentDynamicToolCall("UnknownTool", {}), /Unsupported agent tool/);
  assert.throws(() => parseAgentDynamicToolCall("AssignTask", {
    description: "Research BDD",
    subagent_type: ScoutAgentRoles.Coordinator,
    prompt: "Inspect evidence",
  }), /subagent_type/);
  assert.throws(() => parseAgentDynamicToolCall("ArchiveTask", {
    task_id: " ",
  }), /ArchiveTask task_id/);
});

test("readSendMessageAttachment extracts a requested attachment from a successful call", () => {
  const message = "<wait-for-human-request>\nNeed target account.\n</wait-for-human-request>";
  const attachment = readSendMessageAttachment([
    {
      namespace: "other_namespace",
      tool: "SendMessage",
      arguments: { to: "coordinator", message },
      success: true,
    },
    {
      namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
      tool: "SendMessage",
      arguments: { to: "coordinator", message },
      success: false,
    },
    {
      namespace: AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
      tool: "SendMessage",
      arguments: { to: "coordinator", message },
      success: true,
    },
  ], "wait-for-human-request");

  assert.deepEqual(attachment, {
    body: "Need target account.",
  });
  assert.equal(readSendMessageAttachment([], "wait-for-human-request"), undefined);
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

function hasSchemaProperty(schema: unknown, key: string): boolean {
  const object = readObject(schema);
  const properties = readObject(object.properties);
  return key in properties;
}

function readObject(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}
