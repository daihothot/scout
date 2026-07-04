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
    interruptKind: "human_input",
    taskId: "task-1",
    agentId: "verifier",
    requestId: "input-1",
  });

  const prompt = attachments.compose(undefined, userMessage, dispatch, interrupt);
  assert.equal(attachments.haveTagBlock(prompt, CoordinatorContextTags.User), true);
  assert.equal(attachments.haveTagBlock(prompt, CoordinatorContextTags.Observation), true);

  const userPayload = JSON.parse(
    attachments.readTagBlock(prompt, CoordinatorContextTags.User)[0]?.body ?? "{}",
  ) as { text?: string };
  const observationPayloads = attachments.readTagBlock(prompt, CoordinatorContextTags.Observation)
    .map((block) => JSON.parse(block.body) as { type?: string; eventKey?: string });

  assert.equal(userPayload.text, "用户输入 BDD");
  const interruptPayload = observationPayloads.find((payload) => payload.type === "interrupt");
  assert.ok(interruptPayload);
  assert.equal(interruptPayload.eventKey, "agent.interrupt.raised");
});
