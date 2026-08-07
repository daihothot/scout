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
            sandbox: {
              type: message.params.sandbox === "workspace-write"
                ? "workspaceWrite"
                : "readOnly",
            },
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
      path: "sessions/2026/08/02/rollout-thread-persisted.jsonl",
      model: "gpt-5.5",
      modelProvider: "GuruOpenAI",
      cwd: "/repo",
      runtimeWorkspaceRoots: ["/repo", "/shared/knowledge"],
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
            sandbox: { type: "workspaceWrite" },
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
        sandbox: "workspace-write",
      }),
      /unexpected runtime workspace roots/,
    );
  } finally {
    client.close();
  }
});

test("CodexAppServerClient updates and confirms persisted thread settings", async () => {
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
      if (message.method === "thread/settings/update") {
        send({ id: message.id, result: {} });
        send({
          method: "thread/settings/updated",
          params: { unrelated: true },
        });
        const sandboxPolicy = message.params.sandboxPolicy.type === "workspaceWrite"
          ? {
              ...message.params.sandboxPolicy,
              writableRoots: message.params.sandboxPolicy.writableRoots.filter(
                (root) => root !== message.params.cwd,
              ),
            }
          : message.params.sandboxPolicy;
        setTimeout(() => send({
          method: "thread/settings/updated",
          params: {
            threadId: message.params.threadId,
            threadSettings: {
              cwd: message.params.cwd,
              approvalPolicy: message.params.approvalPolicy,
              sandboxPolicy,
            },
          },
        }), 10);
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
    const workspaceWrite = await client.updateThreadSettings({
      threadId: "thread-persisted",
      cwd: "/relocated/repo",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/relocated/repo", "/shared/knowledge"],
        networkAccess: false,
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: false,
      },
      timeoutMs: 1000,
    });

    assert.deepEqual(workspaceWrite.updateInput, {
      threadId: "thread-persisted",
      cwd: "/relocated/repo",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/relocated/repo", "/shared/knowledge"],
        networkAccess: false,
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: false,
      },
    });
    assert.deepEqual(workspaceWrite.threadSettings, {
      cwd: "/relocated/repo",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/shared/knowledge"],
        networkAccess: false,
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: false,
      },
    });
    assert.deepEqual(workspaceWrite.response, {});

    const readOnly = await client.updateThreadSettings({
      threadId: "thread-persisted",
      cwd: "/relocated/repo",
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
      },
      timeoutMs: 1000,
    });
    assert.deepEqual(readOnly.threadSettings.sandboxPolicy, {
      type: "readOnly",
      networkAccess: false,
    });
  } finally {
    client.close();
  }
});

test("CodexAppServerClient rejects unconfirmed persisted thread settings", async () => {
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
      if (message.method === "thread/settings/update") {
        send({ id: message.id, result: {} });
        send({
          method: "thread/settings/updated",
          params: {
            threadId: message.params.threadId,
            threadSettings: {
              cwd: message.params.cwd,
              sandboxPolicy: {
                type: "workspaceWrite",
                writableRoots: ["/unexpected"],
              },
            },
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
      client.updateThreadSettings({
        threadId: "thread-persisted",
        cwd: "/relocated/repo",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/relocated/repo"],
        },
        timeoutMs: 1000,
      }),
      /unexpected sandbox writable roots/,
    );
  } finally {
    client.close();
  }
});

test("CodexAppServerClient reports each persisted thread settings contract failure", async () => {
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
      if (message.method !== "thread/settings/update") return;

      if (message.params.threadId === "thread-response-timeout") {
        send({
          method: "thread/settings/updated",
          params: {
            threadId: message.params.threadId,
            threadSettings: {
              cwd: message.params.cwd,
              approvalPolicy: message.params.approvalPolicy,
              sandboxPolicy: message.params.sandboxPolicy,
            },
          },
        });
        return;
      }
      send({ id: message.id, result: {} });
      if (message.params.threadId === "thread-timeout") return;

      const sandboxPolicy = message.params.sandboxPolicy === undefined
        ? undefined
        : { ...message.params.sandboxPolicy };
      const threadSettings = {
        cwd: message.params.cwd,
        approvalPolicy: message.params.approvalPolicy,
        sandboxPolicy,
      };
      switch (message.params.threadId) {
        case "thread-cwd-mismatch":
          threadSettings.cwd = "/wrong/repo";
          break;
        case "thread-invalid-cwd":
          threadSettings.cwd = 9;
          break;
        case "thread-approval-mismatch":
          threadSettings.approvalPolicy = "on-request";
          break;
        case "thread-sandbox-type-mismatch":
          threadSettings.sandboxPolicy = { type: "readOnly", networkAccess: false };
          break;
        case "thread-network-mismatch":
          threadSettings.sandboxPolicy.networkAccess = true;
          break;
        case "thread-exclude-slash-tmp-mismatch":
          threadSettings.sandboxPolicy.excludeSlashTmp = false;
          break;
        case "thread-exclude-tmpdir-mismatch":
          threadSettings.sandboxPolicy.excludeTmpdirEnvVar = true;
          break;
        case "thread-invalid-exclude-tmpdir":
          threadSettings.sandboxPolicy.excludeTmpdirEnvVar = "false";
          break;
        case "thread-missing-cwd":
          delete threadSettings.cwd;
          break;
        case "thread-invalid-approval":
          threadSettings.approvalPolicy = 42;
          break;
        case "thread-missing-approval":
          delete threadSettings.approvalPolicy;
          break;
        case "thread-missing-sandbox-type":
          delete threadSettings.sandboxPolicy.type;
          break;
        case "thread-invalid-network":
          threadSettings.sandboxPolicy.networkAccess = "false";
          break;
        case "thread-missing-network":
          delete threadSettings.sandboxPolicy.networkAccess;
          break;
        case "thread-missing-exclude-slash-tmp":
          delete threadSettings.sandboxPolicy.excludeSlashTmp;
          break;
        case "thread-missing-exclude-tmpdir":
          delete threadSettings.sandboxPolicy.excludeTmpdirEnvVar;
          break;
        case "thread-invalid-roots":
          threadSettings.sandboxPolicy.writableRoots = ["/shared/knowledge", 7];
          break;
        case "thread-missing-sandbox":
          delete threadSettings.sandboxPolicy;
          break;
      }
      send({
        method: "thread/settings/updated",
        params: {
          threadId: message.params.threadId,
          threadSettings,
        },
      });
    });
  `);
  const client = new CodexAppServerClient({
    codexPath: fakeServer,
    home: tmpdir(),
    codexHome: tmpdir(),
    providerName: "missing-provider",
  });
  const baseSettings = {
    cwd: "/relocated/repo",
    approvalPolicy: "never" as const,
    sandboxPolicy: {
      type: "workspaceWrite" as const,
      writableRoots: ["/relocated/repo", "/shared/knowledge"],
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: false,
    },
    timeoutMs: 1000,
  };

  try {
    await client.startSession();
    const failures: Array<[string, RegExp]> = [
      ["thread-cwd-mismatch", /cwd to \/wrong\/repo/],
      ["thread-invalid-cwd", /cwd to 9/],
      ["thread-approval-mismatch", /approval policy to on-request/],
      ["thread-sandbox-type-mismatch", /sandbox policy to readOnly/],
      ["thread-network-mismatch", /sandbox networkAccess to true/],
      ["thread-exclude-slash-tmp-mismatch", /sandbox excludeSlashTmp to false/],
      ["thread-exclude-tmpdir-mismatch", /sandbox excludeTmpdirEnvVar to true/],
      ["thread-invalid-exclude-tmpdir", /sandbox excludeTmpdirEnvVar to false/],
      ["thread-missing-cwd", /cwd to undefined/],
      ["thread-invalid-approval", /approval policy to 42/],
      ["thread-missing-approval", /approval policy to undefined/],
      ["thread-missing-sandbox-type", /invalid sandbox policy type/],
      ["thread-invalid-network", /sandbox networkAccess to false/],
      ["thread-missing-network", /sandbox networkAccess to undefined/],
      ["thread-missing-exclude-slash-tmp", /sandbox excludeSlashTmp to undefined/],
      ["thread-missing-exclude-tmpdir", /sandbox excludeTmpdirEnvVar to undefined/],
      ["thread-invalid-roots", /unexpected sandbox writable roots/],
      ["thread-missing-sandbox", /invalid sandbox policy/],
    ];
    for (const [threadId, expectedError] of failures) {
      await assert.rejects(
        client.updateThreadSettings({ threadId, ...baseSettings }),
        expectedError,
      );
    }

    await assert.rejects(
      client.updateThreadSettings({
        threadId: "thread-timeout",
        ...baseSettings,
        timeoutMs: 20,
      }),
      /Timed out waiting for thread\/settings\/updated on thread thread-timeout after 20ms\./,
    );
    await assert.rejects(
      client.updateThreadSettings({
        threadId: "thread-response-timeout",
        ...baseSettings,
        timeoutMs: 20,
      }),
      /Timed out waiting for thread\/settings\/update response on thread thread-response-timeout after 20ms\./,
    );
  } finally {
    client.close();
  }
});

test("CodexAppServerClient cancels a settings update when the client closes", async () => {
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
      if (message.method === "thread/settings/update") {
        send({ id: message.id, result: {} });
      }
    });
  `);
  const client = new CodexAppServerClient({
    codexPath: fakeServer,
    home: tmpdir(),
    codexHome: tmpdir(),
    providerName: "missing-provider",
  });

  await client.startSession();
  const update = client.updateThreadSettings({
    threadId: "thread-closing",
    cwd: "/relocated/repo",
    timeoutMs: 5000,
  });
  setTimeout(() => client.close(), 20);
  await assert.rejects(update, /Codex app-server closed/);
  client.close();
});

test("CodexAppServerClient serializes settings updates for one thread", async () => {
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
      if (message.method !== "thread/settings/update") return;
      send({ id: message.id, result: {} });
      const delay = message.params.approvalPolicy === "never" ? 40 : 5;
      setTimeout(() => send({
        method: "thread/settings/updated",
        params: {
          threadId: message.params.threadId,
          threadSettings: {
            cwd: message.params.cwd,
            approvalPolicy: message.params.approvalPolicy,
            sandboxPolicy: message.params.sandboxPolicy,
          },
        },
      }), delay);
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
    const [first, second] = await Promise.all([
      client.updateThreadSettings({
        threadId: "thread-serialized",
        cwd: "/relocated/repo",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        timeoutMs: 1000,
      }),
      client.updateThreadSettings({
        threadId: "thread-serialized",
        cwd: "/relocated/repo",
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        timeoutMs: 1000,
      }),
    ]);
    assert.equal(first.threadSettings.approvalPolicy, "never");
    assert.equal(second.threadSettings.approvalPolicy, "on-request");
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
    let startedTurnId: string | undefined;
    const turn = await client.runTurn({
      threadId: thread.threadId,
      prompt: "say done",
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
