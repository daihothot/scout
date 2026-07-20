import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_ARCHIVE_TASK_TOOL_NAMESPACE,
  AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
  AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
  AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE,
  AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
  AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
  buildArchiveTaskDynamicTool,
  buildAssignTaskDynamicTool,
  buildRequestHumanInputDynamicTool,
  buildRespondHumanInputDynamicTool,
  buildSendMessageDynamicTool,
  buildSubmitTaskDynamicTool,
  parseAgentDynamicToolCall,
} from "../../src/agent/tools/agent-tools.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";

const repoRoot = process.cwd();

test("agent dynamic tool specs expose stable namespaces and required fields", () => {
  const assignTaskTool = buildAssignTaskDynamicTool();
  const sendMessageTool = buildSendMessageDynamicTool();
  const requestHumanInputTool = buildRequestHumanInputDynamicTool();
  const respondHumanInputTool = buildRespondHumanInputDynamicTool();
  const submitTaskTool = buildSubmitTaskDynamicTool();
  const archiveTaskTool = buildArchiveTaskDynamicTool();

  assert.equal(assignTaskTool.namespace, AGENT_ASSIGN_TASK_TOOL_NAMESPACE);
  assert.equal(sendMessageTool.namespace, AGENT_SEND_MESSAGE_TOOL_NAMESPACE);
  assert.equal(requestHumanInputTool.namespace, AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE);
  assert.equal(respondHumanInputTool.namespace, AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE);
  assert.equal(submitTaskTool.namespace, AGENT_SUBMIT_TASK_TOOL_NAMESPACE);
  assert.equal(archiveTaskTool.namespace, AGENT_ARCHIVE_TASK_TOOL_NAMESPACE);
  assert.deepEqual(readRequired(assignTaskTool.inputSchema), ["description", "subagent_type", "prompt"]);
  assert.deepEqual(readRequired(sendMessageTool.inputSchema), ["to", "message"]);
  assert.deepEqual(readRequired(requestHumanInputTool.inputSchema), ["request"]);
  assert.deepEqual(readRequired(respondHumanInputTool.inputSchema), ["task_id", "response"]);
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
    message: " 继续验证 ",
  }), {
    tool: "SendMessage",
    to: "researcher",
    message: "继续验证",
  });
  assert.deepEqual(parseAgentDynamicToolCall("RequestHumanInput", {
    request: " 请选择目标账号 ",
  }), {
    tool: "RequestHumanInput",
    request: "请选择目标账号",
  });
  assert.deepEqual(parseAgentDynamicToolCall("RespondHumanInput", {
    task_id: " task-1 ",
    response: " 使用测试账号 ",
  }), {
    tool: "RespondHumanInput",
    task_id: "task-1",
    response: "使用测试账号",
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
  assert.throws(() => parseAgentDynamicToolCall("RequestHumanInput", { request: " " }), /RequestHumanInput request/);
  assert.throws(() => parseAgentDynamicToolCall("RespondHumanInput", {
    task_id: "task-1",
    response: " ",
  }), /RespondHumanInput response/);
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

test("AGENTS and Skills do not duplicate Dynamic Tool or Runtime protocol contracts", () => {
  const agentRoot = join(repoRoot, "assets", "codex", "agents");
  const skillRoot = join(repoRoot, "assets", "codex", "skills");
  const files = [
    join(agentRoot, "AGENTS.md"),
    ...readdirSync(agentRoot)
      .filter((name) => name.endsWith(".AGENTS.md"))
      .map((name) => join(agentRoot, name)),
    ...readdirSync(skillRoot)
      .map((name) => join(skillRoot, name, "SKILL.md")),
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(
      text,
      /\b(?:AssignTask|SendMessage|RequestHumanInput|RespondHumanInput|SubmitTask|ArchiveTask)\b/,
      file,
    );
    assert.doesNotMatch(
      text,
      /attachment|tag block|<wait-for-human-request>|<human-response>/i,
      file,
    );
  }
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
