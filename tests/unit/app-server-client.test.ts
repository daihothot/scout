import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";
import { AppServerTimelineStreams } from "../../src/agent-server/codex/app-server-event-store.js";

test("CodexAppServerClient sends explicit model and reasoning configuration", async () => {
  const fakeServer = writeFakeAppServer(`
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        send({ id: message.id, result: { ok: true } });
        return;
      }
      if (message.method === "thread/start") {
        send({ id: message.id, result: { thread: { id: "thread-defaults" }, params: message.params } });
        return;
      }
      if (message.method === "turn/start") {
        send({ id: message.id, result: { turn: { id: "turn-defaults" }, params: message.params } });
      }
    });
  `);
  const client = new CodexAppServerClient({
    codexPath: fakeServer,
    home: tmpdir(),
    codexHome: tmpdir(),
    providerName: "missing-provider",
  });

  try {
    await client.startSession();
    const model = {
      id: "gpt-5.5",
      provider: "GuruOpenAI",
      reasoningEffort: "high",
      reasoningSummary: "concise",
    } as const;
    const thread = await client.startThread({
      cwd: tmpdir(),
      model: model.id,
      modelProvider: model.provider,
      reasoningEffort: model.reasoningEffort,
    });
    const turn = await client.startTurn({
      threadId: thread.threadId,
      prompt: "inspect defaults",
      model: model.id,
      reasoningEffort: model.reasoningEffort,
      reasoningSummary: model.reasoningSummary,
    });
    const threadResponse = thread.response as { params: Record<string, unknown> };
    const turnResponse = turn.response as { params: Record<string, unknown> };

    assert.equal(threadResponse.params.model, model.id);
    assert.equal(threadResponse.params.modelProvider, model.provider);
    assert.deepEqual(threadResponse.params.config, {
      model_reasoning_effort: model.reasoningEffort,
    });
    assert.deepEqual(thread.startInput, threadResponse.params);
    assert.equal(turnResponse.params.model, model.id);
    assert.equal(turnResponse.params.effort, model.reasoningEffort);
    assert.equal(turnResponse.params.summary, model.reasoningSummary);
  } finally {
    client.close();
  }
});

test("CodexAppServerClient resumes a persisted thread without returning turn history", async () => {
  const fakeServer = writeFakeAppServer(`
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        send({ id: message.id, result: { ok: true } });
        return;
      }
      if (message.method === "thread/resume") {
        send({ id: message.id, result: { thread: { id: message.params.threadId }, params: message.params } });
      }
    });
  `);
  const client = new CodexAppServerClient({
    codexPath: fakeServer,
    home: tmpdir(),
    codexHome: tmpdir(),
    providerName: "missing-provider",
  });

  try {
    await client.startSession();
    const resumed = await client.resumeThread({
      threadId: "thread-persisted",
      cwd: "/repo",
      model: "gpt-5.5",
      modelProvider: "GuruOpenAI",
      reasoningEffort: "high",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      config: { feature: true },
      baseInstructions: "base",
      developerInstructions: "developer",
    });
    const response = resumed.response as { params: Record<string, unknown> };

    assert.equal(resumed.threadId, "thread-persisted");
    assert.deepEqual(resumed.resumeInput, response.params);
    assert.deepEqual(response.params, {
      threadId: "thread-persisted",
      excludeTurns: true,
      model: "gpt-5.5",
      modelProvider: "GuruOpenAI",
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      config: {
        feature: true,
        model_reasoning_effort: "high",
      },
      baseInstructions: "base",
      developerInstructions: "developer",
    });
    assert.equal("dynamicTools" in response.params, false);
  } finally {
    client.close();
  }
});

test("CodexAppServerClient publishes timeline after store state is reduced", async () => {
  const fakeServer = writeFakeAppServer(`
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        send({ id: message.id, result: { ok: true } });
        return;
      }
      if (message.method === "thread/start") {
        send({ id: message.id, result: { thread: { id: "thread-1" } } });
        send({ method: "thread/started", params: { thread: { id: "thread-1", status: "running" } } });
        return;
      }
      if (message.method === "turn/start") {
        send({ id: message.id, result: { turn: { id: "turn-1" } } });
        send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
        send({ method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1", explanation: "plan", plan: [{ step: "one", status: "inProgress" }] } });
        send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "item-1", type: "commandExecution", command: "echo ok", status: "inProgress" } } });
        send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "item-1", type: "commandExecution", command: "echo ok", status: "completed", exitCode: 0 } } });
        send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "done" } });
        send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
      }
    });
  `);
  const client = new CodexAppServerClient({
    codexPath: fakeServer,
    home: tmpdir(),
    codexHome: tmpdir(),
    providerName: "missing-provider",
  });
  const timelineSnapshots: Array<{ kind: string; progressCount: number; planSteps: number }> = [];
  client.onTimeline((entry) => {
    const resolved = client.resolveTimelineEntry(entry);
    timelineSnapshots.push({
      kind: entry.kind,
      progressCount: client.getEventStoreSnapshot().progressItems.length,
      planSteps: resolved.plan?.steps.length ?? 0,
    });
  });

  try {
    await client.startSession();
    const thread = await client.startThread({ cwd: tmpdir() });
    const turn = await client.runTurn({ threadId: thread.threadId, prompt: "say done", timeoutMs: 2000 });

    assert.equal(turn.finalResponse, "done");
    assert.equal(turn.progressItems?.[0]?.status, "completed");
    assert.ok(timelineSnapshots.some((snapshot) =>
      snapshot.kind === "item_started" && snapshot.progressCount === 1
    ));
    assert.ok(timelineSnapshots.some((snapshot) =>
      snapshot.kind === "plan_updated" && snapshot.planSteps === 1
    ));
    assert.equal(client.timelineSince(0, { stream: AppServerTimelineStreams.Item }).length, 3);
  } finally {
    client.close();
  }
});

test("CodexAppServerClient exposes turn interrupt without coupling it to runTurn", async () => {
  const fakeServer = writeFakeAppServer(`
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        send({ id: message.id, result: { ok: true } });
        return;
      }
      if (message.method === "turn/interrupt") {
        send({ id: message.id, result: { interrupted: true, params: message.params } });
      }
    });
  `);
  const client = new CodexAppServerClient({
    codexPath: fakeServer,
    home: tmpdir(),
    codexHome: tmpdir(),
    providerName: "missing-provider",
  });

  try {
    await client.startSession();
    const result = await client.interruptTurn({
      threadId: "thread-1",
      turnId: "turn-1",
    });

    assert.deepEqual(result, {
      interrupted: true,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
  } finally {
    client.close();
  }
});

test("CodexAppServerClient persists stderr diagnostics and optional NDJSON transport", async () => {
  const fakeServer = writeFakeAppServer(`
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
    process.stderr.write("fake app-server diagnostic\\n");
    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        send({ id: message.id, result: { ok: true } });
      }
    });
  `);
  const root = mkdtempSync(join(tmpdir(), "scout-app-server-logging-"));
  const stderrLogPath = join(root, "logs", "app-server.log");
  const transportLogPath = join(root, "logs", "app-server.ndjson");
  const client = new CodexAppServerClient({
    codexPath: fakeServer,
    home: root,
    codexHome: root,
    providerName: "missing-provider",
    logPrefix: "test app-server",
    stderrLogPath,
    transportLogPath,
  });

  try {
    await client.startSession();
    await waitFor(() =>
      existsSync(stderrLogPath)
      && readFileSync(stderrLogPath, "utf8").includes("fake app-server diagnostic")
    );

    const stderrText = readFileSync(stderrLogPath, "utf8");
    assert.match(stderrText, /^\d{4}-\d{2}-\d{2}T.+Z \[test app-server\] fake app-server diagnostic/m);

    const transport = readFileSync(transportLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        direction?: string;
        payload?: { method?: string; id?: number; result?: unknown };
      });
    assert.ok(transport.some((entry) =>
      entry.direction === "outgoing" && entry.payload?.method === "initialize"
    ));
    assert.ok(transport.some((entry) =>
      entry.direction === "incoming" && entry.payload?.id === 1 && entry.payload.result !== undefined
    ));
  } finally {
    client.close();
  }
});

test("CodexAppServerClient does not report an intentional close as a disconnect", async () => {
  const fakeServer = writeFakeAppServer(`
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        send({ id: message.id, result: { ok: true } });
      }
    });
  `);
  const root = mkdtempSync(join(tmpdir(), "scout-app-server-close-"));
  const stderrLogPath = join(root, "logs", "app-server.log");
  const client = new CodexAppServerClient({
    codexPath: fakeServer,
    home: root,
    codexHome: root,
    providerName: "missing-provider",
    stderrLogPath,
  });
  const timelineKinds: string[] = [];
  client.onTimeline((entry) => timelineKinds.push(entry.kind));

  await client.startSession();
  client.close();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(timelineKinds.includes("disconnect"), false);
  assert.equal(
    existsSync(stderrLogPath) && readFileSync(stderrLogPath, "utf8").includes("exited with signal"),
    false,
  );
});

function writeFakeAppServer(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "scout-fake-app-server-"));
  const path = join(root, "fake-app-server.cjs");
  writeFileSync(path, `#!/usr/bin/env node\n${source.trim()}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}
