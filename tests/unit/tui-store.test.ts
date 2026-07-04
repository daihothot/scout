import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessageSend } from "../../src/interaction/port.js";
import { TuiStore } from "../../src/interaction/tui/tui-store.js";

test("TuiStore emits user-message ids for user input", () => {
  const store = new TuiStore();
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
