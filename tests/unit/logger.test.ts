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

  const globalText = readFileSync(join(root, "logs", "runtime.log"), "utf8");
  const agentText = readFileSync(join(root, "agents", "agent-1", "logs", "runtime.log"), "utf8");
  assert.match(globalText, /^\n\n\n\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[Scout\] \[pid:\d+\/thread:\d+\] \[ I \] \[test\] \[agent-1\] event=secret_event run=run-1/);
  assert.match(globalText, /api_key: \[redacted\]/);
  assert.match(globalText, /token: \[redacted\]/);
  assert.match(globalText, /\.\.\.\[truncated:4100\]/);
  assert.match(globalText, /\[truncated_items:5\]/);
  assert.match(agentText, /\[test\] \[agent-1\]/);
});

test("Logger formats JSON, XML and YAML string values across lines", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-logger-test-"));
  const logger = new Logger({
    runId: "run-1",
    logsRoot: join(root, "logs"),
  });

  logger.info({
    module: "test",
    event: "json_string_event",
    data: {
      schema: "{\"type\":\"object\",\"properties\":{\"ok\":{\"type\":\"boolean\"}}}",
      xml: "<root><child enabled=\"true\">value</child></root>",
      yaml: "name: scout\nstatus: ok",
    },
  });

  const text = readFileSync(join(root, "logs", "runtime.log"), "utf8");
  assert.match(text, /^\n\n\n\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[Scout\] \[pid:\d+\/thread:\d+\] \[ I \] \[test\] \[runtime\]/);
  assert.match(text, /event=json_string_event/);
  assert.match(text, /schema:\n\s+\{/);
  assert.match(text, /"properties": \{/);
  assert.match(text, /"ok": \{/);
  assert.match(text, /xml:\n\s+<root>/);
  assert.match(text, /<child enabled="true">value<\/child>/);
  assert.match(text, /yaml:\n\s+name: scout\n\s+status: ok/);
});

test("Logger supports custom redactor and summarizer hooks", () => {
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
  });

  logger.warn({
    module: "test",
    event: "custom_event",
    data: {
      raw: true,
    },
  });

  const text = readFileSync(join(root, "logs", "runtime.log"), "utf8");
  assert.match(text, /event=custom_event/);
  assert.match(text, /summarized: true/);
  assert.match(text, /redacted: true/);
});
