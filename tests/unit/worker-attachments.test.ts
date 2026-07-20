import test from "node:test";
import assert from "node:assert/strict";
import { attachments } from "../../src/agent/context/index.js";
import { AgentContextTags, agent } from "../../src/agent/context/agent-attachments.js";

test("agent turn attachments build payload text", () => {
  assert.equal(agent.turn.use_update_tools(), [
    "<use-update-tools>",
    "使用内置 update_plan 工具维护当前任务计划。",
    "创建、修改、开始、完成、阻塞、跳过或替换计划步骤时调用 update_plan。",
    "能够用 update_plan 表达计划变化时，不要只在自然语言中描述。",
    "</use-update-tools>",
  ].join("\n"));

  const message = agent.turn.message("继续处理当前 task");
  assert.equal(message, [
    "<message>",
    "继续处理当前 task",
    "</message>",
  ].join("\n"));

  const humanRequest = agent.turn.wait_for_human_request("请选择 A 或 B");
  assert.equal(humanRequest, [
    "<wait-for-human-request>",
    "请选择 A 或 B",
    "</wait-for-human-request>",
  ].join("\n"));

  const taskOutcome = agent.turn.task_outcome("## Outcome\n\n- Artifact: result.md");
  assert.equal(taskOutcome, [
    "<task-outcome>",
    "## Outcome",
    "",
    "- Artifact: result.md",
    "</task-outcome>",
  ].join("\n"));

  const humanResponse = agent.turn.human_response("选择 A");
  assert.equal(humanResponse, [
    "<human-response>",
    "选择 A",
    "</human-response>",
  ].join("\n"));
});

test("attachments compose valid tag blocks and reject invalid blocks", () => {
  assert.equal(attachments.compose(
    attachments.addTagBlock("message", "A"),
    attachments.addTagBlock("human-response", "B"),
  ), [
    "<message>",
    "A",
    "</message>",
    "",
    "<human-response>",
    "B",
    "</human-response>",
  ].join("\n"));
  assert.throws(
    () => attachments.compose(attachments.addTagBlock("message", "A"), "<broken>"),
    /Invalid attachment block at index 1/,
  );
});

test("plain agent messages reject Runtime protocol tags", () => {
  assert.throws(
    () => agent.turn.message(agent.turn.human_response("选择 A")),
    /must not contain Runtime tag: human-response/,
  );
  assert.throws(
    () => agent.turn.message(agent.turn.wait_for_human_request("请选择 A 或 B")),
    /must not contain Runtime tag: wait-for-human-request/,
  );
});

test("attachments manage tag blocks", () => {
  const text = [
    "before",
    attachments.addTagBlock("human-response", "A"),
    "after",
  ].join("\n");

  assert.equal(attachments.haveTagBlock(text, AgentContextTags.HumanResponse), true);
  assert.deepEqual(attachments.readTagBlock(text, AgentContextTags.HumanResponse).map((block) => block.body), ["A"]);
  assert.equal(attachments.removeTagBlock(text, AgentContextTags.HumanResponse), [
    "before",
    "A",
    "after",
  ].join("\n"));
  assert.equal(attachments.replaceTagBlock(text, AgentContextTags.HumanResponse, "B"), [
    "before",
    "<human-response>",
    "B",
    "</human-response>",
    "after",
  ].join("\n"));
});
