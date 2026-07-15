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
  const dispatch = coordinator.observation({
    type: "dispatch",
    dispatchId: "dispatch-1",
    reason: "agent_error",
    message: "需要 Coordinator 处理调度状态。",
    createdAt: "2026-07-03T00:00:01.000Z",
    data: { code: "agent_error" },
  });
  const interrupt = coordinator.observation({
    type: "interrupt",
    eventKey: "agent.interrupt.raised",
    interruptKind: "approval",
    taskId: "task-1",
    agentId: "verifier",
    requestId: "input-1",
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
    dispatch,
    interrupt,
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
  const observationPayloads = observationBlocks
    .filter((block) => !block.body.startsWith("### Task Assigned")
      && !block.body.startsWith("### Task Not Assigned"))
    .map((block) => JSON.parse(block.body) as { type?: string; eventKey?: string; agentId?: string; taskId?: string });

  assert.equal(userPayload.text, "用户输入 BDD");
  const interruptPayload = observationPayloads.find((payload) => payload.type === "interrupt");
  assert.ok(interruptPayload);
  assert.equal(interruptPayload.eventKey, "agent.interrupt.raised");
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
