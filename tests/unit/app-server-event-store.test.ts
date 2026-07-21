import test from "node:test";
import assert from "node:assert/strict";
import {
  AppServerEventStore,
  AppServerTimelineStreams,
} from "../../src/agent-server/codex/app-server-event-store.js";
import type {
  JsonRpcNotification,
  JsonRpcServerRequest,
} from "../../src/agent-server/codex/app-server-client.js";

test("AppServerEventStore reduces plan, goal, item progress and final response", () => {
  const store = new AppServerEventStore();

  store.ingestNotification(notification("thread/started", {
    thread: {
      id: "thread-1",
      status: "running",
    },
  }));
  store.ingestNotification(notification("turn/started", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "inProgress",
    },
  }));
  store.ingestNotification(notification("thread/goal/updated", {
    threadId: "thread-1",
    goal: {
      threadId: "thread-1",
      objective: "Verify checkout flow",
      status: "active",
      tokenBudget: 1000,
      tokensUsed: 10,
    },
  }));
  store.ingestNotification(notification("turn/plan/updated", {
    threadId: "thread-1",
    turnId: "turn-1",
    explanation: "BDD verification plan",
    plan: [
      { step: "Open fixture", status: "completed" },
      { step: "Check evidence", status: "inProgress" },
    ],
  }));
  store.ingestNotification(notification("item/started", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      id: "item-1",
      type: "commandExecution",
      command: "npm test",
      cwd: "/repo",
      status: "inProgress",
    },
  }));
  store.ingestNotification(notification("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      id: "item-1",
      type: "commandExecution",
      command: "npm test",
      cwd: "/repo",
      status: "completed",
      exitCode: 0,
    },
  }));
  store.ingestNotification(notification("item/agentMessage/delta", {
    threadId: "thread-1",
    turnId: "turn-1",
    delta: "done",
  }));
  store.ingestNotification(notification("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
    },
  }));

  const snapshot = store.snapshot();
  const thread = snapshot.threads["thread-1"];
  assert.equal(thread.goal?.objective, "Verify checkout flow");
  assert.equal(thread.plan.steps.length, 2);
  assert.equal(thread.turns["turn-1"].finalResponse, "done");
  assert.equal(snapshot.progressItems.length, 1);
  assert.equal(snapshot.progressItems[0]?.type, "commandExecution");
  assert.equal(snapshot.progressItems[0]?.status, "completed");

  const latest = store.timelineSince(0).at(-1);
  assert.equal(latest?.kind, "turn_completed");
  assert.equal(store.resolveTimelineEntry(latest!).thread?.id, "thread-1");
});

test("AppServerEventStore handles local server request resolution and clears pending request", () => {
  const store = new AppServerEventStore();
  const request: JsonRpcServerRequest = {
    id: 9,
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "SendMessage",
    },
  };

  store.ingestServerRequest(request);
  assert.equal(store.snapshot().pendingRequests["9"]?.method, "item/tool/call");

  store.resolveServerRequest({
    id: 9,
    status: "success",
    result: {
      success: true,
    },
  });

  const snapshot = store.snapshot();
  assert.equal(snapshot.pendingRequests["9"], undefined);
  const requestEntries = snapshot.timeline.filter((entry) => entry.stream === AppServerTimelineStreams.Request);
  assert.deepEqual(requestEntries.map((entry) => entry.kind), [
    "server_request",
    "server_request_resolved",
  ]);
  const resolved = store.resolveTimelineEntry(requestEntries[1]!);
  assert.equal(resolved.request?.resolution?.status, "success");
  assert.equal(resolved.request?.method, "item/tool/call");
});

test("AppServerEventStore limits timeline and reports dropped entries", () => {
  const store = new AppServerEventStore({ timelineLimit: 2 });

  store.ingestNotification(notification("thread/status/changed", {
    threadId: "thread-1",
    status: "running",
  }));
  store.ingestNotification(notification("thread/status/changed", {
    threadId: "thread-2",
    status: "running",
  }));
  store.ingestNotification(notification("thread/status/changed", {
    threadId: "thread-3",
    status: "running",
  }));

  const snapshot = store.snapshot();
  assert.equal(snapshot.timeline.length, 2);
  assert.equal(snapshot.droppedTimelineCount, 1);
  assert.deepEqual(snapshot.timeline.map((entry) => entry.threadId), ["thread-2", "thread-3"]);
});

test("AppServerEventStore ignores JSON-RPC responses as timeline events", () => {
  const store = new AppServerEventStore();

  store.ingestResponse({ id: 1, result: { ok: true } });

  assert.equal(store.snapshot().timeline.length, 0);
});

test("AppServerEventStore normalizes user messages and aggregates reasoning summaries", () => {
  const store = new AppServerEventStore();

  store.ingestNotification(notification("item/started", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      id: "user-1",
      type: "userMessage",
      content: [{ type: "inputText", text: "inspect checkout" }],
      clientId: "client-1",
    },
  }));
  store.ingestNotification(notification("item/started", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      id: "reasoning-1",
      type: "reasoning",
      summary: [],
      content: ["raw reasoning must remain private"],
    },
  }));
  store.ingestNotification(notification("item/reasoning/summaryPartAdded", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "reasoning-1",
    summaryIndex: 0,
  }));
  store.ingestNotification(notification("item/reasoning/summaryTextDelta", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "reasoning-1",
    summaryIndex: 0,
    delta: "Inspecting ",
  }));
  store.ingestNotification(notification("item/reasoning/summaryTextDelta", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "reasoning-1",
    summaryIndex: 0,
    delta: "checkout evidence",
  }));

  const userMessage = store.itemSnapshot({
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "user-1",
  });
  assert.equal(userMessage?.type, "userMessage");
  assert.deepEqual(userMessage?.type === "userMessage" ? userMessage.content : undefined, [
    { type: "inputText", text: "inspect checkout" },
  ]);

  const summaryEntries = store.timelineSince(0).filter((entry) =>
    entry.kind === "reasoning_summary_delta"
  );
  assert.equal(summaryEntries.length, 2);
  const resolved = store.resolveTimelineEntry(summaryEntries.at(-1)!);
  assert.equal(resolved.item?.type, "reasoning");
  assert.deepEqual(resolved.item?.type === "reasoning" ? resolved.item.summary : undefined, [
    "Inspecting checkout evidence",
  ]);
});

test("AppServerEventStore normalizes native subagent control and lifecycle items", () => {
  const store = new AppServerEventStore();

  store.ingestNotification(notification("item/completed", {
    threadId: "thread-researcher",
    turnId: "turn-1",
    item: {
      id: "collab-1",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "thread-researcher",
      receiverThreadIds: ["thread-child-1"],
      prompt: "检查一个边界明确的只读子任务。",
      model: "gpt-5.5",
      reasoningEffort: "high",
      agentsStates: {
        "thread-child-1": {
          status: "running",
          message: null,
        },
      },
    },
  }));
  store.ingestNotification(notification("item/completed", {
    threadId: "thread-researcher",
    turnId: "turn-1",
    item: {
      id: "subagent-activity-1",
      type: "subAgentActivity",
      kind: "started",
      agentThreadId: "thread-child-1",
      agentPath: "019f-child-1",
    },
  }));

  const collab = store.itemSnapshot({
    threadId: "thread-researcher",
    turnId: "turn-1",
    itemId: "collab-1",
  });
  assert.deepEqual(collab, {
    id: "collab-1",
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: "thread-researcher",
    receiverThreadIds: ["thread-child-1"],
    prompt: "检查一个边界明确的只读子任务。",
    model: "gpt-5.5",
    reasoningEffort: "high",
    agentsStates: {
      "thread-child-1": {
        status: "running",
        message: null,
      },
    },
  });
  assert.deepEqual(store.progressItem({
    threadId: "thread-researcher",
    turnId: "turn-1",
    itemId: "collab-1",
  }), {
    itemId: "collab-1",
    threadId: "thread-researcher",
    turnId: "turn-1",
    type: "collabAgentToolCall",
    status: "completed",
    label: "Native subagent spawnAgent",
    detail: "thread-child-1",
    item: collab,
    updatedAt: store.turnSnapshot("thread-researcher", "turn-1")?.updatedAt,
  });
  assert.deepEqual(store.itemSnapshot({
    threadId: "thread-researcher",
    turnId: "turn-1",
    itemId: "subagent-activity-1",
  }), {
    id: "subagent-activity-1",
    type: "subAgentActivity",
    kind: "started",
    agentThreadId: "thread-child-1",
    agentPath: "019f-child-1",
  });
});

function notification(method: string, params: unknown): JsonRpcNotification {
  return {
    method,
    params,
  };
}
