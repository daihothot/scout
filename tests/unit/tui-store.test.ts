import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentMessageSend,
  RuntimeProgressEvent,
} from "../../src/interaction/port.js";
import { TuiStore } from "../../src/interaction/tui/tui-store.js";

test("TuiStore emits user-message ids for user input", () => {
  const store = createStore();
  const sent: AgentMessageSend[] = [];
  store.sendAgentMessage((message) => {
    sent.push(message);
  });

  store.receiveAgentMessage({
    id: "coordinator-message-1",
    text: "Coordinator reply",
  });
  store.submitInput("  继续  ");

  assert.equal(sent.length, 1);
  assert.match(sent[0]?.id ?? "", /^user-message-\d+$/);
  assert.notEqual(sent[0]?.id, "coordinator-message-1");
  assert.equal(sent[0]?.text, "继续");
});

test("TuiStore tracks runtime metadata", () => {
  const store = createStore();

  assert.deepEqual(store.snapshot().runtime, {
    cwd: "/repo/scout",
    version: "0.1.0",
    model: "gpt-5.5",
    reasoningEffort: "high",
    status: "preparing",
  });

  store.setRun({
    runId: "run-1",
    status: "ready",
  });

  assert.deepEqual(store.snapshot().runtime, {
    cwd: "/repo/scout",
    version: "0.1.0",
    model: "gpt-5.5",
    reasoningEffort: "high",
    runId: "run-1",
    status: "ready",
  });
});

test("TuiStore preserves same item id for Coordinator and Worker", () => {
  const store = createStore();
  store.addProgress(progressEvent({
    agentId: "coordinator",
    label: "Coordinator thinking",
  }));
  store.addProgress(progressEvent({
    agentId: "researcher",
    label: "Researcher searching",
  }));

  const progress = store.snapshot().progress;
  assert.equal(progress.length, 2);
  assert.equal(store.snapshot().logs.length, 0);
  assert.deepEqual(
    progress.map((item) => [item.agentId, item.label]),
    [
      ["coordinator", "Coordinator thinking"],
      ["researcher", "Researcher searching"],
    ],
  );
});

function createStore(): TuiStore {
  return new TuiStore({
    cwd: "/repo/scout",
    version: "0.1.0",
    model: "gpt-5.5",
    reasoningEffort: "high",
  });
}

function progressEvent(input: {
  agentId: string;
  label: string;
}): RuntimeProgressEvent {
  return {
    source: "agent.app_server.item",
    agentId: input.agentId,
    itemId: "item-1",
    type: "agentMessage",
    status: "inProgress",
    label: input.label,
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}
