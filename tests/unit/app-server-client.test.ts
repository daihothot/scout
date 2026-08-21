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
        send({
          id: message.id,
          result: {
            thread: { id: "thread-defaults" },
            activePermissionProfile: { id: message.params.permissions },
            params: message.params,
            receivedProviderApiKey: process.env.CODEX_API_KEY === "target-device-token",
          },
        });
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
    providerApiKey: "target-device-token",
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
      permissions: "scout-researcher",
      model: model.id,
      modelProvider: model.provider,
      reasoningEffort: model.reasoningEffort,
    });
    const turn = await client.startTurn({
      threadId: thread.threadId,
      prompt: "inspect defaults",
      permissions: "scout-researcher",
      model: model.id,
      reasoningEffort: model.reasoningEffort,
      reasoningSummary: model.reasoningSummary,
    });
    const threadResponse = thread.response as {
      params: Record<string, unknown>;
      receivedProviderApiKey: boolean;
    };
    const turnResponse = turn.response as { params: Record<string, unknown> };

    assert.equal(threadResponse.params.model, model.id);
    assert.equal(threadResponse.params.modelProvider, model.provider);
    assert.equal(threadResponse.receivedProviderApiKey, true);
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

test("CodexAppServerClient applies and confirms one named permission profile", async () => {
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
        send({
          id: message.id,
          result: {
            thread: { id: "thread-permissions" },
            activePermissionProfile: { id: message.params.permissions },
            params: message.params,
          },
        });
        return;
      }
      if (message.method === "thread/resume") {
        send({
          id: message.id,
          result: {
            thread: { id: message.params.threadId },
            cwd: message.params.cwd,
            runtimeWorkspaceRoots: message.params.runtimeWorkspaceRoots,
            approvalPolicy: message.params.approvalPolicy,
            activePermissionProfile: { id: message.params.permissions },
            params: message.params,
          },
        });
        return;
      }
      if (message.method === "turn/start") {
        send({
          id: message.id,
          result: { turn: { id: "turn-permissions" }, params: message.params },
        });
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
    const permissions = "scout-researcher";
    const started = await client.startThread({
      cwd: "/repo/mount",
      runtimeWorkspaceRoots: ["/repo/mount"],
      approvalPolicy: "never",
      permissions,
      ephemeral: false,
    });
    const resumed = await client.resumeThread({
      threadId: started.threadId,
      cwd: "/relocated/repo/mount",
      runtimeWorkspaceRoots: ["/relocated/repo/mount"],
      approvalPolicy: "never",
      permissions,
    });
    const turn = await client.startTurn({
      threadId: started.threadId,
      prompt: "inspect",
      permissions,
    });
    const startParams = (started.response as { params: Record<string, unknown> }).params;
    const resumeParams = (resumed.response as { params: Record<string, unknown> }).params;
    const turnParams = (turn.response as { params: Record<string, unknown> }).params;

    assert.equal(startParams.permissions, permissions);
    assert.equal("sandbox" in startParams, false);
    assert.deepEqual(startParams.runtimeWorkspaceRoots, ["/repo/mount"]);
    assert.equal(resumeParams.permissions, permissions);
    assert.equal("sandbox" in resumeParams, false);
    assert.equal(turnParams.permissions, permissions);
    assert.equal("sandboxPolicy" in turnParams, false);
  } finally {
    client.close();
  }
});

test("CodexAppServerClient rejects a mismatched permission selection", async () => {
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
        send({
          id: message.id,
          result: {
            thread: { id: "thread-wrong-profile" },
            activePermissionProfile: { id: "scout-validator" },
          },
        });
        return;
      }
      if (message.method === "thread/resume") {
        send({
          id: message.id,
          result: {
            thread: { id: message.params.threadId },
            cwd: message.params.cwd,
            runtimeWorkspaceRoots: message.params.runtimeWorkspaceRoots,
            approvalPolicy: message.params.approvalPolicy,
            activePermissionProfile: { id: "scout-validator" },
          },
        });
        return;
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
    await assert.rejects(
      client.startThread({ cwd: "/repo", permissions: "scout-researcher" }),
      /permission profile scout-validator, expected scout-researcher/,
    );
    await assert.rejects(
      client.resumeThread({
        threadId: "thread-wrong-profile",
        cwd: "/repo",
        runtimeWorkspaceRoots: ["/repo"],
        approvalPolicy: "never",
        permissions: "scout-researcher",
      }),
      /permission profile scout-validator, expected scout-researcher/,
    );
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
        const path = require("node:path");
        send({
          id: message.id,
          result: {
            thread: {
              id: message.params.threadId,
              path: path.resolve(process.env.CODEX_HOME, message.params.path),
            },
            cwd: message.params.cwd,
            model: message.params.model,
            modelProvider: message.params.modelProvider,
            approvalPolicy: message.params.approvalPolicy,
            runtimeWorkspaceRoots: message.params.runtimeWorkspaceRoots,
            activePermissionProfile: { id: message.params.permissions },
            params: message.params,
          },
        });
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
      path: "sessions/2026/08/02/rollout-thread-persisted.jsonl",
      cwd: "/repo",
      runtimeWorkspaceRoots: ["/repo", "/shared/knowledge"],
      model: "gpt-5.5",
      modelProvider: "GuruOpenAI",
      reasoningEffort: "high",
      approvalPolicy: "never",
      permissions: "scout-researcher",
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
      path: "sessions/2026/08/02/rollout-thread-persisted.jsonl",
      model: "gpt-5.5",
      modelProvider: "GuruOpenAI",
      cwd: "/repo",
      runtimeWorkspaceRoots: ["/repo", "/shared/knowledge"],
      approvalPolicy: "never",
      permissions: "scout-researcher",
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

test("CodexAppServerClient rejects a resume response from a different runtime workspace", async () => {
  const fakeServer = writeFakeAppServer(`
    const readline = require("node:readline");
    const path = require("node:path");
    const rl = readline.createInterface({ input: process.stdin });
    function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        send({ id: message.id, result: { ok: true } });
        return;
      }
      if (message.method === "thread/resume") {
        send({
          id: message.id,
          result: {
            thread: {
              id: message.params.threadId,
              path: path.resolve(process.env.CODEX_HOME, message.params.path),
            },
            cwd: message.params.cwd,
            model: message.params.model,
            modelProvider: message.params.modelProvider,
            approvalPolicy: message.params.approvalPolicy,
            runtimeWorkspaceRoots: ["/stale/device/root"],
            activePermissionProfile: { id: message.params.permissions },
          },
        });
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
    await assert.rejects(
      client.resumeThread({
        threadId: "thread-persisted",
        path: "sessions/rollout-thread-persisted.jsonl",
        cwd: "/relocated/repo",
        runtimeWorkspaceRoots: ["/relocated/repo"],
        model: "gpt-5.5",
        modelProvider: "GuruOpenAI",
        approvalPolicy: "never",
        permissions: "scout-researcher",
      }),
      /unexpected runtime workspace roots/,
    );
  } finally {
    client.close();
  }
});

test("CodexAppServerClient serializes shared plugin-manager operations", async () => {
  const fakeServer = writeFakeAppServer(`
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") send({ id: message.id, result: { ok: true } });
    });
  `);
  const client = new CodexAppServerClient({
    codexPath: fakeServer,
    home: tmpdir(),
    codexHome: tmpdir(),
    providerName: "missing-provider",
  });
  const events: string[] = [];
  let releaseFirst!: () => void;
  let signalFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  const first = client.withPluginManagerLock(async () => {
    events.push("first:start");
    signalFirstStarted();
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    events.push("first:end");
    return "first";
  });

  try {
    await client.startSession();
    await firstStarted;
    const second = client.withPluginManagerLock(async () => {
      events.push("second:start");
      events.push("second:end");
      return "second";
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["first:start"]);
    releaseFirst();
    assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
    assert.deepEqual(events, [
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  } finally {
    releaseFirst?.();
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
        send({
          id: message.id,
          result: {
            thread: { id: "thread-1" },
            activePermissionProfile: { id: message.params.permissions },
          },
        });
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
    const thread = await client.startThread({
      cwd: tmpdir(),
      permissions: "scout-researcher",
    });
    let startedTurnId: string | undefined;
    const turn = await client.runTurn({
      threadId: thread.threadId,
      prompt: "say done",
      permissions: "scout-researcher",
      timeoutMs: 2000,
      onTurnStarted: (turnId) => {
        startedTurnId = turnId;
      },
    });

    assert.equal(turn.finalResponse, "done");
    assert.equal(startedTurnId, "turn-1");
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

test("CodexAppServerClient steers an active turn with its expected turn id", async () => {
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
      if (message.method === "turn/steer") {
        send({ id: message.id, result: { turnId: message.params.expectedTurnId, params: message.params } });
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
    const result = await client.steerTurn({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      prompt: "处理这个紧急事件",
      clientUserMessageId: "message-1",
    });
    assert.equal(result.turnId, "turn-1");
    assert.deepEqual((result.response as { params: Record<string, unknown> }).params, {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      clientUserMessageId: "message-1",
      input: [{ type: "text", text: "处理这个紧急事件", text_elements: [] }],
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

test("CodexAppServerClient keeps multiline diagnostics out of the TUI terminal", async () => {
  const fakeServer = writeFakeAppServer(`
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
    process.stderr.write("ERROR first line\\nERROR second line\\n");
    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") send({ id: message.id, result: { ok: true } });
    });
  `);
  const root = mkdtempSync(join(tmpdir(), "scout-app-server-tui-diagnostics-"));
  const stderrLogPath = join(root, "logs", "app-server.log");
  const client = new CodexAppServerClient({
    codexPath: fakeServer,
    home: root,
    codexHome: root,
    providerName: "missing-provider",
    logPrefix: "tui app-server",
    stderrLogPath,
    writeDiagnosticsToStderr: false,
  });
  const originalWrite = process.stderr.write;
  let terminalWrites = 0;
  process.stderr.write = ((..._args: Parameters<typeof originalWrite>) => {
    terminalWrites += 1;
    return true;
  }) as typeof originalWrite;

  try {
    await client.startSession();
    await waitFor(() =>
      existsSync(stderrLogPath)
      && readFileSync(stderrLogPath, "utf8").includes("ERROR second line")
    );
  } finally {
    process.stderr.write = originalWrite;
    client.close();
  }

  const stderrText = readFileSync(stderrLogPath, "utf8");
  assert.match(stderrText, /ERROR first line/);
  assert.match(stderrText, /ERROR second line/);
  assert.equal(terminalWrites, 0);
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
  await assert.rejects(
    client.request("after-close", {}),
    /Codex app-server is closed/,
  );
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
