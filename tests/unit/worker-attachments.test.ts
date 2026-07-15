import test from "node:test";
import assert from "node:assert/strict";
import { attachments } from "../../src/agent/context/index.js";
import { AgentContextTags, agent } from "../../src/agent/context/agent-attachments.js";
import { WorkerContextTags, worker } from "../../src/agent/runner/worker/worker-attachments.js";

test("agent turn attachments build payload text", () => {
  assert.equal(agent.turn.use_update_tools(), [
    "<use-update-tools>",
    "Use the built-in update_plan tool to keep the task plan current.",
    "Call update_plan when you create, change, start, complete, block, skip, or supersede plan steps.",
    "Do not describe plan changes only in text when update_plan can represent them.",
    "</use-update-tools>",
  ].join("\n"));

  const taskTick = attachments.readTagBlock(worker.turn.task_tick({
    taskId: "task-1",
    status: "running",
    description: "处理任务",
    latestStepId: "step-1",
  }), WorkerContextTags.TaskTick)[0]?.body;

  assert.deepEqual(JSON.parse(taskTick ?? "{}"), {
    type: "task_tick",
    task: {
      taskId: "task-1",
      status: "running",
      description: "处理任务",
      latestStepId: "step-1",
    },
    instruction: "continue_current_task",
  });

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
