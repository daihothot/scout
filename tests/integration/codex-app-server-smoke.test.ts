import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";

const enabled = process.env.SCOUT_RUN_CODEX_APP_SERVER_INTEGRATION === "1";

test("real Codex app-server produces timeline and completed turn", { skip: enabled ? undefined : "set SCOUT_RUN_CODEX_APP_SERVER_INTEGRATION=1" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-real-app-server-"));
  const userHome = process.env.HOME ?? root;
  const codexHome = process.env.CODEX_HOME ?? join(userHome, ".codex");
  if (!existsSync(codexHome)) {
    throw new Error(`Codex home does not exist: ${codexHome}`);
  }
  const client = new CodexAppServerClient({
    home: userHome,
    codexHome,
    logPrefix: "scout integration app-server",
  });
  const timelineKinds: string[] = [];
  client.onTimeline((entry) => {
    timelineKinds.push(entry.kind);
  });

  try {
    await client.startSession();
    const thread = await client.startThread({
      cwd: root,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: "你是 Scout 集成测试 agent。只回答用户要求的固定文本。",
      developerInstructions: "必须只输出：scout-app-server-smoke-ok",
    });
    const turn = await client.runTurn({
      threadId: thread.threadId,
      prompt: "输出 scout-app-server-smoke-ok，不要添加其它内容。",
      timeoutMs: 60000,
      sandbox: "readOnly",
    });

    assert.match(turn.finalResponse, /scout-app-server-smoke-ok/);
    assert.ok(timelineKinds.includes("turn_started"));
    assert.ok(timelineKinds.includes("turn_completed"));
    assert.ok(client.getEventStoreSnapshot().threadOrder.includes(thread.threadId));
  } finally {
    client.close();
  }
});
