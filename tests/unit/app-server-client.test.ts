import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";
import { AppServerTimelineStreams } from "../../src/agent-server/codex/app-server-event-store.js";

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
  client.onTimeline((entry, resolved) => {
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

function writeFakeAppServer(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "scout-fake-app-server-"));
  const path = join(root, "fake-app-server.cjs");
  writeFileSync(path, `#!/usr/bin/env node\n${source.trim()}\n`);
  chmodSync(path, 0o755);
  return path;
}
