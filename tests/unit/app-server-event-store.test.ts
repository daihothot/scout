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

test("AppServerEventStore records local server request resolution and clears pending request", () => {
  const store = new AppServerEventStore();
  const request: JsonRpcServerRequest = {
    id: 9,
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "RequestHumanInput",
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

  store.ingestResponse({ id: 1, result: {} });
  store.ingestResponse({ id: 2, result: {} });
  store.ingestResponse({ id: 3, result: {} });

  const snapshot = store.snapshot();
  assert.equal(snapshot.timeline.length, 2);
  assert.equal(snapshot.droppedTimelineCount, 1);
  assert.deepEqual(snapshot.timeline.map((entry) => entry.requestId), ["2", "3"]);
});

function notification(method: string, params: unknown): JsonRpcNotification {
  return {
    method,
    params,
  };
}
