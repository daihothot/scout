import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../../src/core/logging/index.js";

test("Logger routes agent info to the agent log and warnings to both logs", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-logger-test-"));
  const runtimeLogPath = join(root, "logs", "runtime.log");
  const agentLogPath = join(root, "agents", "agent-1", "logs", "runtime.log");
  const logger = new Logger({
    runId: "run-1",
    logsRoot: join(root, "logs"),
  });
  logger.registerAgentLogRoot("agent-1", join(root, "agents", "agent-1", "logs"));

  logger.info({
    module: "test",
    event: "agent_info",
    agentId: "agent-1",
    data: {
      api_key: "should-not-appear",
      nested: { token: "hidden" },
      output: "x".repeat(4100),
      items: Array.from({ length: 205 }, (_, index) => index),
    },
  });

  assert.equal(existsSync(runtimeLogPath), false);
  let agentEvents = readEvents(agentLogPath);
  assert.equal(agentEvents.length, 1);
  assert.match(agentEvents[0] ?? "", /^\d{4}-\d{2}-\d{2}T.+Z INFO module=test event=agent_info run=run-1 agent=agent-1\ndata:/);
  assert.equal(agentEvents[0]?.includes("should-not-appear"), false);
  assert.equal(agentEvents[0]?.includes("hidden"), false);
  assert.match(agentEvents[0] ?? "", /\[redacted\]/);
  assert.match(agentEvents[0] ?? "", /\.\.\.\[truncated:4100\]/);
  assert.match(agentEvents[0] ?? "", /\[truncated_items:5\]/);

  logger.warn({
    module: "test",
    event: "agent_warning",
    agentId: "agent-1",
  });
  logger.info({
    module: "test",
    event: "runtime_info",
  });

  const runtimeEvents = readEvents(runtimeLogPath);
  agentEvents = readEvents(agentLogPath);
  assert.deepEqual(runtimeEvents.map(readEventName), ["agent_warning", "runtime_info"]);
  assert.deepEqual(agentEvents.map(readEventName), ["agent_info", "agent_warning"]);
});

test("Logger pretty-prints structured data below the event header", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-logger-test-"));
  const logger = new Logger({
    runId: "run-1",
    logsRoot: join(root, "logs"),
  });

  logger.info({
    module: "test",
    event: "structured_event",
    data: {
      schema: "{\"type\":\"object\",\"properties\":{\"ok\":{\"type\":\"boolean\"}}}",
      xml: "<root><child enabled=\"true\">value</child></root>",
      yaml: "name: scout\nstatus: ok",
    },
  });

  const events = readEvents(join(root, "logs", "runtime.log"));
  assert.equal(events.length, 1);
  assert.match(events[0] ?? "", /\ndata:\n  schema:/);
  assert.ok((events[0]?.split("\n").length ?? 0) > 4);
  assert.match(events[0] ?? "", /schema: "\{\\"type\\":\\"object\\"/);
  assert.match(events[0] ?? "", /xml: "<root><child enabled=\\"true\\">value<\/child><\/root>"/);
  assert.match(events[0] ?? "", /yaml: \|\n    name: scout\n    status: ok/);
});

test("Logger supports custom redactor and summarizer hooks", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-logger-test-"));
  const logger = new Logger({
    runId: "run-1",
    logsRoot: join(root, "logs"),
    summarizer: (event) => ({
      ...event,
      data: { summarized: true },
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
    data: { raw: true },
  });

  const [event] = readEvents(join(root, "logs", "runtime.log"));
  assert.match(event ?? "", /data:\n  summarized: true\n  redacted: true/);
});

test("Logger physically wraps long preview strings", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-logger-wrap-test-"));
  const logger = new Logger({
    runId: "run-wrap",
    logsRoot: join(root, "logs"),
  });
  const preview = "preview-content-".repeat(30);

  logger.info({
    module: "test",
    event: "long_preview",
    data: {
      prompt: {
        chars: preview.length,
        preview,
        truncated: true,
      },
    },
  });

  const [event] = readEvents(join(root, "logs", "runtime.log"));
  const lines = (event ?? "").split("\n");
  const previewIndex = lines.findIndex((line) => line === "    preview: |");
  assert.notEqual(previewIndex, -1);
  const wrappedPreview = lines.slice(previewIndex + 1, lines.indexOf("    truncated: true"));
  assert.ok(wrappedPreview.length > 1);
  assert.ok(wrappedPreview.every((line) => line.length <= 120));
  assert.equal(wrappedPreview.map((line) => line.slice(6)).join(""), preview);
});

test("Logger keeps high-volume agent activity out of the runtime log", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-logger-volume-test-"));
  const runtimeLogPath = join(root, "logs", "runtime.log");
  const agentLogPath = join(root, "agents", "agent-1", "logs", "runtime.log");
  const logger = new Logger({
    runId: "run-volume",
    logsRoot: join(root, "logs"),
  });
  logger.registerAgentLogRoot("agent-1", join(root, "agents", "agent-1", "logs"));

  for (let index = 0; index < 1000; index += 1) {
    logger.info({
      module: "agent.item",
      event: "item_completed",
      agentId: "agent-1",
      data: { index },
    });
  }
  logger.info({
    module: "run.lifecycle",
    event: "run_ready",
  });

  assert.equal(readEvents(runtimeLogPath).length, 1);
  assert.equal(readEvents(agentLogPath).length, 1000);
});

function readEvents(path: string): string[] {
  return readFileSync(path, "utf8")
    .trim()
    .split(/\n(?=\d{4}-\d{2}-\d{2}T)/)
    .filter(Boolean);
}

function readEventName(line: string): string | undefined {
  return /(?:^| )event=([^ ]+)/.exec(line)?.[1];
}
