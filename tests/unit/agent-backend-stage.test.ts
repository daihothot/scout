import assert from "node:assert/strict";
import test from "node:test";
import type { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";
import { AgentBackendStage } from "../../src/run/lifecycle/stages/agent-backend-stage.js";
import { AuthorizationStage } from "../../src/run/lifecycle/stages/authorization-stage.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("AgentBackendStage rolls back partial subscriptions and can retry all three entries", async (t) => {
  const authorizationStage = new AuthorizationStage();
  const stage = new AgentBackendStage();
  t.after(async () => { await stage.stop(); await authorizationStage.stop(); });
  const live = new Set<string>();
  let rejectRequest = true;
  const client = {
    onTimeline() { live.add("timeline"); return () => { live.delete("timeline"); }; },
    setDynamicToolCallHandler() { live.add("dynamic-tool"); return () => { live.delete("dynamic-tool"); }; },
    onServerRequest() {
      if (rejectRequest) throw new Error("request subscription failed");
      live.add("request"); return () => { live.delete("request"); };
    },
  } as unknown as CodexAppServerClient;
  await installTestRunScope(t, { runId: "backend-stage", appServer: client });
  await assert.rejects(stage.start(), /Authorization Service is not available/);
  assert.equal(live.size, 0);
  await authorizationStage.start();
  await assert.rejects(stage.start(), /request subscription failed/);
  assert.equal(live.size, 0);
  rejectRequest = false;
  await stage.start(); await stage.start();
  assert.deepEqual([...live], ["timeline", "dynamic-tool", "request"]);
  await stage.stop(); await stage.stop();
  assert.equal(live.size, 0);
});
