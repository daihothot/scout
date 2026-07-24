import test from "node:test";
import assert from "node:assert/strict";
import { attachments } from "../../src/agent/context/index.js";
import {
  CoordinatorContextTags,
  coordinator,
} from "../../src/agent/runner/coordinator/coordinator-attachments.js";

test("coordinator attachments build tagged context blocks", () => {
  const userMessage = coordinator.user({
    messageId: "message-1",
    text: "用户输入 BDD",
    submittedAt: "2026-07-03T00:00:00.000Z",
  });
  const taskAssigned = coordinator.taskAssigned({
    agentId: "verifier",
    taskId: "task-1",
  });
  const taskNotAssigned = coordinator.taskNotAssigned({
    agentId: "verifier",
    role: "verifier",
    activeTaskId: "task-1",
    requestedDescription: "Verify another BDD",
    reason: "The current task has not been archived.",
  });

  const prompt = attachments.compose(
    userMessage,
    taskAssigned,
    taskNotAssigned,
  );
  assert.equal(attachments.haveTagBlock(prompt, CoordinatorContextTags.User), true);
  assert.equal(attachments.haveTagBlock(prompt, CoordinatorContextTags.Observation), true);

  const userPayload = JSON.parse(
    attachments.readTagBlock(prompt, CoordinatorContextTags.User)[0]?.body ?? "{}",
  ) as { text?: string };
  const observationBlocks = attachments.readTagBlock(prompt, CoordinatorContextTags.Observation);
  const taskAssignedBody = observationBlocks
    .find((block) => block.body.startsWith("### Task Assigned"))?.body;
  const taskNotAssignedBody = observationBlocks
    .find((block) => block.body.startsWith("### Task Not Assigned"))?.body;

  assert.equal(userPayload.text, "用户输入 BDD");
  assert.equal(taskAssignedBody, [
    "### Task Assigned",
    "",
    "- Agent ID: verifier",
    "- Task ID: task-1",
  ].join("\n"));
  assert.equal(taskNotAssignedBody, [
    "### Task Not Assigned",
    "",
    "- Agent ID: verifier",
    "- Role: verifier",
    "- Active Task ID: task-1",
    "- Requested Task: Verify another BDD",
    "- Reason: The current task has not been archived.",
  ].join("\n"));
});
