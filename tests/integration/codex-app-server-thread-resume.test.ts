import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";

const enabled = process.env.SCOUT_RUN_CODEX_APP_SERVER_INTEGRATION === "1";

test("real Codex app-server restores thread memory across processes", {
  skip: enabled ? undefined : "set SCOUT_RUN_CODEX_APP_SERVER_INTEGRATION=1",
  timeout: 240_000,
}, async (context) => {
  const root = mkdtempSync(join(tmpdir(), "scout-real-thread-resume-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const providerName = "GuruOpenAI";
  writeIsolatedConfig(codexHome, providerName);
  const clientOptions = {
    home,
    codexHome,
    providerName,
    logPrefix: "scout thread resume integration",
  };
  const secret = `SCOUT_THREAD_MEMORY_${Date.now()}`;

  const first = new CodexAppServerClient(clientOptions);
  let threadId: string;
  try {
    await first.startSession();
    const thread = await first.startThread({
      cwd: root,
      model: "gpt-5.5",
      modelProvider: providerName,
      reasoningEffort: "minimal",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      baseInstructions: "You are a thread memory integration test agent. Do not use tools.",
      developerInstructions: "Remember explicit user facts across turns and answer concisely.",
    });
    threadId = thread.threadId;
    const stored = await first.runTurn({
      threadId,
      prompt: `Remember this exact secret for the next turn: ${secret}. Reply only MEMORY_STORED.`,
      timeoutMs: 120_000,
      sandbox: "readOnly",
    });
    assert.match(stored.finalResponse, /MEMORY_STORED/);
  } finally {
    first.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 1_000));

  const second = new CodexAppServerClient(clientOptions);
  try {
    await second.startSession();
    const resumed = await second.resumeThread({
      threadId,
      cwd: root,
      model: "gpt-5.5",
      modelProvider: providerName,
      reasoningEffort: "minimal",
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: "You are a thread memory integration test agent. Do not use tools.",
      developerInstructions: "Remember explicit user facts across turns and answer concisely.",
    });
    assert.equal(resumed.threadId, threadId);
    assert.equal(resumed.resumeInput.excludeTurns, true);

    const recalled = await second.runTurn({
      threadId,
      prompt: "Return only the exact secret I asked you to remember in the previous turn.",
      timeoutMs: 120_000,
      sandbox: "readOnly",
    });
    assert.match(recalled.finalResponse, new RegExp(secret));
    context.diagnostic(JSON.stringify({
      threadId,
      recalled: recalled.finalResponse.trim(),
    }));
  } finally {
    second.close();
  }
});

function writeIsolatedConfig(codexHome: string, providerName: string): void {
  const homeConfig = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
  const escaped = providerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const provider = homeConfig.match(new RegExp(
    `^\\[model_providers\\.${escaped}\\]\\n([\\s\\S]*?)(?=^\\[|\\z)`,
    "m",
  ))?.[1] ?? "";
  const baseUrl = provider.match(/^base_url\s*=\s*"([^"]+)"/m)?.[1];
  const envKey = provider.match(/^env_key\s*=\s*"([^"]+)"/m)?.[1];
  if (!baseUrl || !envKey || !process.env[envKey]) {
    throw new Error(`Provider ${providerName} is unavailable for integration testing.`);
  }
  writeFileSync(join(codexHome, "config.toml"), [
    'model = "gpt-5.5"',
    `model_provider = "${providerName}"`,
    'model_reasoning_effort = "minimal"',
    "",
    `[model_providers.${providerName}]`,
    `name = "${providerName}"`,
    `base_url = "${baseUrl}"`,
    `env_key = "${envKey}"`,
    'wire_api = "responses"',
    "",
  ].join("\n"), "utf8");
}
