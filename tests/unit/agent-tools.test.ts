import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_ARCHIVE_TASK_TOOL_NAMESPACE,
  AGENT_ASSIGN_TASK_TOOL_NAMESPACE,
  AGENT_FIND_SKILLS_TOOL_NAMESPACE,
  AGENT_READ_SKILL_RESOURCE_TOOL_NAMESPACE,
  AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
  AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE,
  AGENT_SEND_MESSAGE_TOOL_NAMESPACE,
  AGENT_SUBMIT_TASK_TOOL_NAMESPACE,
  buildArchiveTaskDynamicTool,
  buildAssignTaskDynamicTool,
  buildFindSkillsDynamicTool,
  buildReadSkillResourceDynamicTool,
  buildRequestHumanInputDynamicTool,
  buildRespondHumanInputDynamicTool,
  buildSendMessageDynamicTool,
  buildSubmitTaskDynamicTool,
  assertAgentToolNamespace,
  parseAgentDynamicToolCall,
} from "../../src/agent/tools/agent-tools.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";

const scoutRoot = process.cwd();

test("agent dynamic tool specs expose stable namespaces and required fields", () => {
  const assignTaskTool = buildAssignTaskDynamicTool();
  const findSkillsTool = buildFindSkillsDynamicTool();
  const readSkillResourceTool = buildReadSkillResourceDynamicTool();
  const sendMessageTool = buildSendMessageDynamicTool();
  const requestHumanInputTool = buildRequestHumanInputDynamicTool();
  const respondHumanInputTool = buildRespondHumanInputDynamicTool();
  const submitTaskTool = buildSubmitTaskDynamicTool();
  const archiveTaskTool = buildArchiveTaskDynamicTool();

  assert.equal(assignTaskTool.namespace, AGENT_ASSIGN_TASK_TOOL_NAMESPACE);
  assert.equal(findSkillsTool.namespace, AGENT_FIND_SKILLS_TOOL_NAMESPACE);
  assert.equal(readSkillResourceTool.namespace, AGENT_READ_SKILL_RESOURCE_TOOL_NAMESPACE);
  assert.equal(sendMessageTool.namespace, AGENT_SEND_MESSAGE_TOOL_NAMESPACE);
  assert.equal(requestHumanInputTool.namespace, AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE);
  assert.equal(respondHumanInputTool.namespace, AGENT_RESPOND_HUMAN_INPUT_TOOL_NAMESPACE);
  assert.equal(submitTaskTool.namespace, AGENT_SUBMIT_TASK_TOOL_NAMESPACE);
  assert.equal(archiveTaskTool.namespace, AGENT_ARCHIVE_TASK_TOOL_NAMESPACE);
  assert.deepEqual(readRequired(assignTaskTool.inputSchema), ["description", "subagent_type", "prompt"]);
  assert.deepEqual(readRequired(findSkillsTool.inputSchema), []);
  assert.equal(hasSchemaProperty(findSkillsTool.inputSchema, "phase"), false);
  assert.deepEqual(readRequired(readSkillResourceTool.inputSchema), ["selection_id", "skill_id", "resource"]);
  assert.equal(readSchemaProperty(findSkillsTool.inputSchema, "family").minItems, 1);
  assert.deepEqual(readSchemaProperty(findSkillsTool.inputSchema, "detail").enum, [
    "names",
    "metadata",
  ]);
  assert.equal(hasSchemaProperty(findSkillsTool.inputSchema, "domain"), false);
  assert.equal(hasSchemaProperty(findSkillsTool.inputSchema, "tags"), false);
  assert.equal(readSchemaProperty(readSkillResourceTool.inputSchema, "resource").maxLength, 512);
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
  assert.match(requestHumanInputTool.description, /必须在本轮结束前调用/);
  assert.match(requestHumanInputTool.description, /普通回复或 SendMessage 不能替代/);
  assert.match(requestHumanInputTool.description, /task 保持 running/);
  assert.match(requestHumanInputTool.description, /不得重复调用或再调用 SubmitTask/);
  assert.match(submitTaskTool.description, /必须在本轮结束前调用/);
  assert.match(submitTaskTool.description, /漏调会使 task 保持 running/);
  assert.match(submitTaskTool.description, /不得重复调用或再调用 RequestHumanInput/);
  assert.match(submitTaskTool.description, /不存在未完成 discovery/);
  assert.match(submitTaskTool.description, /全部 selection.*已 ready/);
  assert.match(submitTaskTool.description, /协议修正 turn 只能.*上一 turn 的全部 ready selections/);
  assert.match(submitTaskTool.description, /先将 task 置为 done，再把 Markdown outcome 投递给 Coordinator/);
  assert.match(findSkillsTool.description, /未知入口时.*每次只前进一步/);
  assert.match(findSkillsTool.description, /已知完整 canonical leaf 时可直接提交完整 family/);
  assert.match(findSkillsTool.description, /为本 turn 重新签发 selection/);
  assert.match(findSkillsTool.description, /tags 只作为结果特征，不参与筛选/);
  assert.match(findSkillsTool.description, /metadata.*安全 Skill frontmatter/);
  assert.match(readSkillResourceTool.description, /任一 FindSkills selection/);
  assert.match(readSkillResourceTool.description, /新 selection 不会撤销.*既有 selection/);
  assert.match(readSkillResourceTool.description, /不能跨 agent、task、thread、turn、phase 或 asset commit/);
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
  assert.deepEqual(parseAgentDynamicToolCall("FindSkills", {
    family: [" Validation ", " Platform ", " Single ", " Local ", " General ", " Runtime-Log "],
    detail: "metadata",
  }), {
    tool: "FindSkills",
    family: ["validation", "platform", "single", "local", "general", "runtime-log"],
    detail: "metadata",
  });
  assert.deepEqual(parseAgentDynamicToolCall("FindSkills", { detail: "names" }), {
    tool: "FindSkills",
    detail: "names",
  });
  assert.deepEqual(parseAgentDynamicToolCall("ReadSkillResource", {
    selection_id: " selection-1 ",
    skill_id: " domain-validation-validator ",
    resource: " templates/research-pack-gate.md ",
  }), {
    tool: "ReadSkillResource",
    selection_id: "selection-1",
    skill_id: "domain-validation-validator",
    resource: "templates/research-pack-gate.md",
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
  assert.throws(() => parseAgentDynamicToolCall("FindSkills", {
    phase: "research",
  }), /no longer accepts phase/);
  assert.throws(() => parseAgentDynamicToolCall("FindSkills", {
    family: [],
  }), /FindSkills family/);
  assert.throws(() => parseAgentDynamicToolCall("FindSkills", {
    family: ["validation", "bad_family"],
  }), /FindSkills family token/);
  assert.throws(() => parseAgentDynamicToolCall("FindSkills", {
    detail: "full",
  }), /FindSkills detail/);
  assert.throws(() => parseAgentDynamicToolCall("ReadSkillResource", {
    selection_id: "selection-1",
    skill_id: "domain-validation-researcher",
    resource: " ",
  }), /ReadSkillResource resource/);
});

test("agent tools are hard-bound to their registered namespaces", () => {
  assert.doesNotThrow(() =>
    assertAgentToolNamespace(AGENT_FIND_SKILLS_TOOL_NAMESPACE, "FindSkills")
  );
  assert.throws(
    () => assertAgentToolNamespace(AGENT_SUBMIT_TASK_TOOL_NAMESPACE, "FindSkills"),
    /must use namespace scout_agent_findskills/,
  );
  assert.throws(
    () => assertAgentToolNamespace(AGENT_FIND_SKILLS_TOOL_NAMESPACE, "UnknownTool"),
    /Unsupported agent tool/,
  );
});

test("common rules own Skill selection transport while Worker rules own lifecycle controls", () => {
  const agentRoot = join(scoutRoot, "assets", "codex", "agents");
  const skillRoot = join(scoutRoot, "assets", "codex", "skills");
  const commonRules = readFileSync(join(agentRoot, "AGENTS.md"), "utf8");
  const workerRules = readFileSync(join(agentRoot, "worker.AGENTS.md"), "utf8");
  for (const toolName of ["FindSkills", "ReadSkillResource"]) {
    assert.match(commonRules, new RegExp(`\\b${toolName}\\b`), toolName);
  }
  for (const toolName of ["update_plan", "RequestHumanInput", "SubmitTask"]) {
    assert.match(workerRules, new RegExp(`\\b${toolName}\\b`), toolName);
  }

  const transportAgnosticFiles = [
    ...readdirSync(agentRoot)
      .filter((name) => name.endsWith(".AGENTS.md") && name !== "worker.AGENTS.md")
      .map((name) => join(agentRoot, name)),
    ...readdirSync(skillRoot)
      .map((name) => join(skillRoot, name, "SKILL.md")),
  ];
  for (const file of transportAgnosticFiles) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(
      text,
      /\b(?:AssignTask|SendMessage|RequestHumanInput|RespondHumanInput|SubmitTask|ArchiveTask)\b/,
      file,
    );
  }

  for (const file of [join(agentRoot, "AGENTS.md"), join(agentRoot, "worker.AGENTS.md"), ...transportAgnosticFiles]) {
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
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

function readSchemaProperty(schema: unknown, key: string): Record<string, unknown> {
  const object = readObject(schema);
  return readObject(readObject(object.properties)[key]);
}

function readObject(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}
