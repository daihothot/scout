import test from "node:test";
import assert from "node:assert/strict";
import { composeAttachmentText } from "../../src/agent/context/index.js";
import {
  getWorkerPendingMessageAttachments,
  worker,
} from "../../src/agent/runner/worker/worker-attachments.js";

test("worker attachments build turn payload text", () => {
  assert.deepEqual(JSON.parse(worker.turn.task_tick({
    taskId: "task-1",
    status: "running",
    description: "处理任务",
    latestStepId: "step-1",
  })), {
    type: "task_tick",
    task: {
      taskId: "task-1",
      status: "running",
      description: "处理任务",
      latestStepId: "step-1",
    },
    instruction: "continue_current_task",
  });

  const [attachment] = getWorkerPendingMessageAttachments({
    messages: ["继续处理当前 task"],
  });

  assert.equal(composeAttachmentText([attachment]), [
    "<pending-message origin=\"coordinator\">",
    "继续处理当前 task",
    "</pending-message>",
  ].join("\n"));
});
