import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../../src/core/logging/index.js";

test("Logger writes global and agent logs with redaction and summarization", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-logger-test-"));
  const logger = new Logger({
    runId: "run-1",
    logsRoot: join(root, "logs"),
  });
  logger.registerAgentLogRoot("agent-1", join(root, "agents", "agent-1", "logs"));

  logger.info({
    module: "test",
    event: "secret_event",
    agentId: "agent-1",
    data: {
      api_key: "should-not-appear",
      nested: {
        token: "hidden",
      },
      output: "x".repeat(4100),
      items: Array.from({ length: 205 }, (_, index) => index),
    },
  });

  const globalEvent = readJsonLine(join(root, "logs", "runtime.jsonl"));
  const agentEvent = readJsonLine(join(root, "agents", "agent-1", "logs", "runtime.jsonl"));
  assert.equal(globalEvent.runId, "run-1");
  assert.equal(agentEvent.agentId, "agent-1");
  assert.equal(globalEvent.data.api_key, "[redacted]");
  assert.equal(globalEvent.data.nested.token, "[redacted]");
  assert.match(globalEvent.data.output, /^\w+\.\.\.\[truncated:4100\]$/);
  assert.equal(globalEvent.data.items.length, 201);
  assert.equal(globalEvent.data.items.at(-1), "[truncated_items:5]");
});

test("Logger supports custom serializer, redactor and summarizer hooks", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-logger-test-"));
  const logger = new Logger({
    runId: "run-1",
    logsRoot: join(root, "logs"),
    summarizer: (event) => ({
      ...event,
      data: {
        summarized: true,
      },
    }),
    redactor: (event) => ({
      ...event,
      data: {
        ...(event.data as Record<string, unknown>),
        redacted: true,
      },
    }),
    serializer: (event) => `custom:${event.event}:${JSON.stringify(event.data)}`,
  });

  logger.warn({
    module: "test",
    event: "custom_event",
    data: {
      raw: true,
    },
  });

  const text = readFileSync(join(root, "logs", "runtime.jsonl"), "utf8").trim();
  assert.equal(text, 'custom:custom_event:{"summarized":true,"redacted":true}');
});

function readJsonLine(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8").trim()) as Record<string, any>;
}
