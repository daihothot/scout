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
  assertAgentToolNamespace,
  parseAgentDynamicToolCall,
} from "../../src/agent/tools/agent-tools.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";

const scoutRoot = process.cwd();

test("agent dynamic tool specs expose stable namespaces, guidance Skills, and required fields", () => {
  const tools = [
    buildAssignTaskDynamicTool(),
    buildSendMessageDynamicTool(),
    buildRequestHumanInputDynamicTool(),
    buildRespondHumanInputDynamicTool(),
    buildSubmitTaskDynamicTool(),
    buildArchiveTaskDynamicTool(),
  ];
  assert.deepEqual(tools.map((tool) => tool.namespace), [
    AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
    AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
    AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
    AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE,
    AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
    AGENT_ARCHIVE_TASK_TOOL_NAMESPACE,
  ]);
  assert.deepEqual(tools.map((tool) => tool.guidanceSkill), [
    "tool-scout-assign-task",
    "tool-scout-send-message",
    "tool-scout-request-human-input",
    "tool-scout-respond-human-input",
    "tool-scout-submit-task",
    "tool-scout-archive-task",
  ]);
  assert.deepEqual(tools.map((tool) => readRequired(tool.inputSchema)), [
    ["description", "subagent_type", "prompt"],
    ["to", "message"],
    ["request"],
    ["task_id", "response"],
    ["outcome"],
    ["task_id"],
  ]);
  assert.deepEqual(readEnumProperty(tools[0]?.inputSchema, "subagent_type"), [
    ScoutAgentRoles.Researcher,
    ScoutAgentRoles.Verifier,
    ScoutAgentRoles.Validator,
  ]);
  for (const tool of tools) {
    assert.doesNotMatch(tool.description, /selection|discovery|完整 contract|生命周期/);
  }
});

test("agent tool parser validates and normalizes each supported payload", () => {
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
  }), { tool: "SendMessage", to: "researcher", message: "继续验证" });
  assert.deepEqual(parseAgentDynamicToolCall("SendMessage", {
    to: " researcher ",
    message: " 立即处理 ",
    delivery_mode: "queued",
  }), {
    tool: "SendMessage",
    to: "researcher",
    message: "立即处理",
    delivery_mode: "queued",
  });
  assert.deepEqual(parseAgentDynamicToolCall("RequestHumanInput", {
    request: " 请选择目标账号 ",
  }), { tool: "RequestHumanInput", request: "请选择目标账号" });
  assert.deepEqual(parseAgentDynamicToolCall("RespondHumanInput", {
    task_id: " task-1 ",
    response: " 使用测试账号 ",
  }), { tool: "RespondHumanInput", task_id: "task-1", response: "使用测试账号" });
  assert.deepEqual(parseAgentDynamicToolCall("SubmitTask", {
    outcome: " ## Outcome\n\nartifact: research/index.md ",
  }), { tool: "SubmitTask", outcome: "## Outcome\n\nartifact: research/index.md" });
  assert.deepEqual(parseAgentDynamicToolCall("ArchiveTask", {
    task_id: " task-1 ",
  }), { tool: "ArchiveTask", task_id: "task-1" });
});

test("agent tool parser rejects malformed and removed Skill tool payloads", () => {
  assert.throws(() => parseAgentDynamicToolCall("AssignTask", null));
  assert.throws(() => parseAgentDynamicToolCall("SendMessage", []));
  assert.throws(() => parseAgentDynamicToolCall("RequestHumanInput", { request: " " }), /RequestHumanInput request/);
  assert.throws(() => parseAgentDynamicToolCall("RespondHumanInput", {
    task_id: "task-1",
    response: " ",
  }), /RespondHumanInput response/);
  assert.throws(() => parseAgentDynamicToolCall("SubmitTask", { outcome: " " }), /SubmitTask outcome/);
  assert.throws(() => parseAgentDynamicToolCall("AssignTask", {
    description: "Research BDD",
    subagent_type: ScoutAgentRoles.Coordinator,
    prompt: "Inspect evidence",
  }), /subagent_type/);
  assert.throws(() => parseAgentDynamicToolCall("ArchiveTask", { task_id: " " }), /ArchiveTask task_id/);
  assert.throws(() => parseAgentDynamicToolCall("FindSkills", {}), /Unsupported agent tool/);
  assert.throws(() => parseAgentDynamicToolCall("ReadSkillResource", {}), /Unsupported agent tool/);
});

test("agent tools are hard-bound to their registered namespaces", () => {
  assert.doesNotThrow(() =>
    assertAgentToolNamespace(AGENT_SUBMIT_TASK_TOOL_NAMESPACE, "SubmitTask")
  );
  assert.throws(
    () => assertAgentToolNamespace(AGENT_ASSIGN_TASK_TOOL_NAMESPACE, "SubmitTask"),
    /must use namespace scout_agent_submittask/,
  );
  assert.throws(
    () => assertAgentToolNamespace(AGENT_SUBMIT_TASK_TOOL_NAMESPACE, "FindSkills"),
    /Unsupported agent tool/,
  );
});

test("global rules keep dynamic tool guidance in independent Tool Skills", () => {
  const agentRoot = join(scoutRoot, "assets", "codex", "agents");
  const skillRoot = join(scoutRoot, "assets", "codex", "skills");
  const commonRules = readFileSync(join(agentRoot, "AGENTS.md"), "utf8");

  assert.doesNotMatch(commonRules, /FindSkills|ReadSkillResource|selectionId|loadOrder/);
  assert.doesNotMatch(commonRules, /tool-scout-/);
  assert.deepEqual(
    readdirSync(agentRoot).filter((name) => name.endsWith(".AGENTS.md")),
    [],
  );
  for (const skillName of readdirSync(skillRoot).filter((name) => name.startsWith("tool-scout-"))) {
    assert.equal(readFileSync(join(skillRoot, skillName, "SKILL.md"), "utf8").length > 0, true);
  }
  for (const file of readdirSync(agentRoot).filter((name) => name.endsWith(".md"))) {
    assert.doesNotMatch(
      readFileSync(join(agentRoot, file), "utf8"),
      /attachment|tag block|<wait-for-human-request>|<human-response>/i,
      file,
    );
  }
});

function readRequired(schema: unknown): string[] {
  const object = readObject(schema);
  return Array.isArray(object.required)
    ? object.required.filter((item): item is string => typeof item === "string")
    : [];
}

function readEnumProperty(schema: unknown, key: string): string[] {
  const object = readObject(schema);
  const properties = readObject(object.properties);
  const property = readObject(properties[key]);
  return Array.isArray(property.enum)
    ? property.enum.filter((item): item is string => typeof item === "string")
    : [];
}

function readObject(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}
