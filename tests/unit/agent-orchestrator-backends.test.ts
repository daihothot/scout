import assert from "node:assert/strict";
import test from "node:test";
import type { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";
import { AuthorizationStage } from "../../src/run/lifecycle/stages/authorization-stage.js";
import { installTestRunScope } from "../helpers/run-persistence.js";
import { currentRunScope } from "../../src/run/run-scope.js";

test("AgentOrchestrator rolls back backend startup and retries without duplicate subscriptions", async (t) => {
  const authorizationStage = new AuthorizationStage();
  t.after(async () => { owner.stopBackends(); await authorizationStage.stop(); });
  const live = new Set<string>();
  const subscriptions: string[] = [];
  let rejectRequest = true;
  const client = {
    onTimeline() { subscriptions.push("timeline"); live.add("timeline"); return () => { live.delete("timeline"); }; },
    setDynamicToolCallHandler() { subscriptions.push("dynamic-tool"); live.add("dynamic-tool"); return () => { live.delete("dynamic-tool"); }; },
    onServerRequest() {
      if (rejectRequest) throw new Error("request subscription failed");
      subscriptions.push("request"); live.add("request"); return () => { live.delete("request"); };
    },
  } as unknown as CodexAppServerClient;
  const scope = await installTestRunScope(t, { runId: "backend-startup", appServer: client });
  const owner = scope.agentOrchestrator;
  assert.throws(() => owner.timelineBackend, /not installed/);
  assert.throws(() => owner.requestBackend, /not installed/);
  assert.throws(() => owner.startBackends(), /Authorization Service is not available/);
  assert.equal(live.size, 0);
  assert.throws(() => currentRunScope().agentOrchestrator.dynamicToolBackend, /not installed/);
  assert.throws(() => owner.timelineBackend, /not installed/);
  assert.throws(() => owner.requestBackend, /not installed/);
  await authorizationStage.start();
  assert.throws(() => owner.startBackends(), /request subscription failed/);
  assert.equal(live.size, 0);
  assert.throws(() => currentRunScope().agentOrchestrator.dynamicToolBackend, /not installed/);
  assert.throws(() => owner.timelineBackend, /not installed/);
  assert.throws(() => owner.requestBackend, /not installed/);
  rejectRequest = false;
  owner.startBackends(); owner.startBackends();
  assert.deepEqual([...live], ["timeline", "dynamic-tool", "request"]);
  const backend = owner.dynamicToolBackend;
  const timeline = owner.timelineBackend;
  const request = owner.requestBackend;
  const subscriptionCount = subscriptions.length;
  assert.equal(owner.dynamicToolBackend, backend);
  owner.startBackends();
  assert.equal(owner.dynamicToolBackend, backend);
  assert.equal(owner.timelineBackend, timeline);
  assert.equal(owner.requestBackend, request);
  assert.equal(subscriptions.length, subscriptionCount);
  assert.deepEqual([...live], ["timeline", "dynamic-tool", "request"]);
  owner.stopBackends(); owner.stopBackends();
  assert.equal(live.size, 0);
  assert.throws(() => owner.dynamicToolBackend, /not installed/);
  assert.throws(() => owner.timelineBackend, /not installed/);
  assert.throws(() => owner.requestBackend, /not installed/);
});

test("AgentOrchestrator retains the failed backend while releasing peers and retries cleanup", async (t) => {
  const authorizationStage = new AuthorizationStage();
  let rejectCleanup = true;
  let dynamicSubscription = false;
  const client = {
    onTimeline() { return () => undefined; },
    setDynamicToolCallHandler() {
      dynamicSubscription = true;
      return () => {
        if (rejectCleanup) throw new Error("dynamic cleanup failed");
        dynamicSubscription = false;
      };
    },
    onServerRequest() { return () => undefined; },
  } as unknown as CodexAppServerClient;
  t.after(async () => { rejectCleanup = false; owner.stopBackends(); await authorizationStage.stop(); });
  await installTestRunScope(t, { runId: "backend-cleanup", appServer: client });
  await authorizationStage.start();
  const owner = currentRunScope().agentOrchestrator;
  owner.startBackends();
  const backend = owner.dynamicToolBackend;
  assert.throws(() => owner.stopBackends(), /Agent backend cleanup failed/);
  assert.equal(owner.dynamicToolBackend, backend);
  assert.throws(() => owner.timelineBackend, /not installed/);
  assert.throws(() => owner.requestBackend, /not installed/);
  assert.equal(dynamicSubscription, true);
  assert.throws(() => owner.startBackends(), /cleanup must finish/);
  rejectCleanup = false;
  owner.stopBackends();
  assert.equal(dynamicSubscription, false);
  assert.throws(() => owner.dynamicToolBackend, /not installed/);
});

test("AgentOrchestrator retains all backend subscriptions across Workflow participation and stops them with the owner", async (t) => {
  const authorizationStage = new AuthorizationStage();
  const live = new Set<string>();
  const released: string[] = [];
  const client = {
    onTimeline() { live.add("timeline"); return () => { live.delete("timeline"); released.push("timeline"); }; },
    setDynamicToolCallHandler() {
      live.add("dynamic-tool");
      return () => { live.delete("dynamic-tool"); released.push("dynamic-tool"); };
    },
    onServerRequest() { live.add("request"); return () => { live.delete("request"); released.push("request"); }; },
  } as unknown as CodexAppServerClient;
  t.after(async () => { owner.stopBackends(); await authorizationStage.stop(); });
  await installTestRunScope(t, { runId: "backend-owner-stop", appServer: client });
  await authorizationStage.start();
  const owner = currentRunScope().agentOrchestrator;
  owner.startBackends();
  const timeline = owner.timelineBackend;
  const dynamicTool = owner.dynamicToolBackend;
  const request = owner.requestBackend;
  await owner.close();
  owner.abort();
  owner.clearWorkflow();
  await owner.create();
  assert.equal(owner.timelineBackend, timeline);
  assert.equal(owner.dynamicToolBackend, dynamicTool);
  assert.equal(owner.requestBackend, request);
  assert.deepEqual([...live], ["timeline", "dynamic-tool", "request"]);
  assert.deepEqual(released, []);
  owner.stop();
  assert.equal(live.size, 0);
  assert.deepEqual(released, ["request", "dynamic-tool", "timeline"]);
  assert.throws(() => owner.startBackends(), /stopped AgentOrchestrator/);
  owner.stop();
  assert.deepEqual(released, ["request", "dynamic-tool", "timeline"]);
});
