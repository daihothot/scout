import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentJsonValue } from "../../src/agent/tools/types.js";
import type { CodexMount } from "../../src/asset-store/contracts/mount.js";
import type { AssetCommit } from "../../src/asset-store/contracts/asset-commit.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { BaseDomain, ScoutDomainId, type ScoutDomainDynamicToolCall } from "../../src/domain/index.js";
import { JarvisWebSocketTool, RbtEvents } from "../../src/domain/domains/rbt/index.js";
import { JarvisBehaviorOrchestrator } from "../../src/domain/domains/rbt/core/jarvis-behavior-orchestrator.js";
import { JarvisBehaviorWebSocketLinker } from "../../src/domain/domains/rbt/core/jarvis-behavior-websocket-linker.js";
import { JarvisBehaviorCommandRunner, type BehaviorCommandExecution } from "../../src/domain/domains/rbt/core/jarvis-behavior-command-runner.js";
import { JarvisBehaviorExecuteFileRunner } from "../../src/domain/domains/rbt/core/jarvis-behavior-execute-file.js";
import { JarvisBehaviorToolStore } from "../../src/domain/domains/rbt/core/jarvis-behavior-tool-store.js";
import { ExecutionEvents, type ExecutionPlatformPort } from "../../src/execution/index.js";
import { HostCommandExecutor } from "../../src/host/host-command-executor.js";
import { installTestRunScope } from "../helpers/run-persistence.js";
import { RbtCampaignExecutionHistoryStore } from "../../src/domain/domains/rbt/agent/history/campaign-execution-history-store.js";

test("RBT serializes initial shared connection and command segments without duplicate launch", async (t) => {
  const fixture = createFixture(t);
  const entered = commandGate();
  const release = commandGate();
  let active = 0;
  let maximum = 0;
  fixture.onCommand = async (command) => {
    active += 1;
    maximum = Math.max(maximum, active);
    if (command === "first") { entered.resolve(); await release.promise; }
    active -= 1;
  };
  const first = fixture.orchestrator.executeCommand("execute", call, "first", {});
  await entered.promise;
  const second = fixture.orchestrator.executeCommand("execute", call, "second", {});
  await Promise.resolve();
  assert.deepEqual(fixture.commands, ["first"]);
  release.resolve();
  assert.equal((await first).success, true);
  assert.equal((await second).success, true);
  assert.equal(maximum, 1);
  assert.deepEqual(fixture.operations, ["identify", "launch"]);
  assert.equal(fixture.linksCreated(), 1);
});

test("RBT reconnect and retry remain inside the same command segment", async (t) => {
  const fixture = createFixture(t);
  const reconnecting = commandGate();
  const release = commandGate();
  let first = true;
  fixture.onCommand = async (command, execution) => {
    if (command === "first" && first) {
      first = false;
      return { ...execution, status: "failed", retryableTransportFailure: true };
    }
  };
  const disconnect = fixture.websocket.disconnect.bind(fixture.websocket);
  t.mock.method(fixture.websocket, "disconnect", async (input: Parameters<JarvisWebSocketTool["disconnect"]>[0]) => {
    reconnecting.resolve();
    await release.promise;
    return disconnect(input);
  });
  const result = fixture.orchestrator.executeCommand("execute", call, "first", {});
  await reconnecting.promise;
  const peer = fixture.orchestrator.executeCommand("execute", call, "second", {});
  await Promise.resolve();
  assert.deepEqual(fixture.commands, ["first"]);
  release.resolve();
  assert.equal((await result).success, true);
  assert.equal((await peer).success, true);
  assert.deepEqual(fixture.commands, ["first", "first", "second"]);
});

test("RBT rolls back its fresh launch even when failed-connection cleanup also throws", async (t) => {
  const fixture = createFixture(t);
  t.mock.method(fixture.websocket, "connectPlatformLink", async () => ({
    ok: false, code: "connect_failed", message: "connection failed", hostCommands: [],
  }));
  const close = fixture.websocket.closePlatformLink.bind(fixture.websocket);
  let closes = 0;
  const failingClose = t.mock.method(fixture.websocket, "closePlatformLink", async () => {
    if (++closes === 2) throw new Error("abort failed");
    await close();
  });
  await assert.rejects(fixture.orchestrator.executeCommand("execute", call, "first", {}), (error) => (
    error instanceof AggregateError && error.errors.length === 2
  ));
  assert.deepEqual(fixture.operations, ["identify", "launch", "shutdown"]);
  assert.deepEqual(fixture.commands, []);
  failingClose.mock.restore();
});

test("RBT closes its connection attempt and rolls back only its fresh launch when connect throws", async (t) => {
  const fixture = createFixture(t);
  const connect = t.mock.method(fixture.websocket, "connectPlatformLink", async () => { throw new Error("connect threw"); });
  const response = await fixture.orchestrator.executeCommand("execute", call, "first", {});
  assert.equal(response.success, false);
  assert.match(response.contentItems[0]!.text, /connect threw/);
  assert.deepEqual(fixture.operations, ["identify", "launch", "shutdown"]);
  connect.mock.restore();
  assert.equal((await fixture.orchestrator.executeCommand("execute", call, "retry", {})).success, true);
  assert.equal(fixture.linksCreated(), 2);
});

test("RBT quiesce rejects new work and drains every accepted command segment", async (t) => {
  const fixture = createFixture(t);
  const entered = commandGate();
  const release = commandGate();
  fixture.onCommand = async (command) => { if (command === "first") { entered.resolve(); await release.promise; } };
  const first = fixture.orchestrator.executeCommand("execute", call, "first", {});
  await entered.promise;
  const second = fixture.orchestrator.executeCommand("execute", call, "second", {});
  let drained = false;
  const stopped = fixture.orchestrator.quiesce().then(() => { drained = true; });
  await assert.rejects(fixture.orchestrator.executeCommand("execute", call, "rejected", {}), /not accepting/);
  assert.equal(drained, false);
  release.resolve();
  await Promise.all([first, second, stopped]);
  assert.deepEqual(fixture.commands, ["first", "second"]);
  assert.equal(drained, true);
  fixture.orchestrator.start();
  assert.equal((await fixture.orchestrator.executeCommand("execute", call, "reopened", {})).success, true);
});

test("RBT execute-file releases its command queue between campaign commands", { timeout: 5_000 }, async (t) => {
  const fixture = createFixture(t);
  const campaignStarted = commandGate();
  const continueCampaign = commandGate();
  fixture.scope.eventBus.subscribe(RbtEvents.campaign.start, async () => {
    campaignStarted.resolve();
    await continueCampaign.promise;
  });
  const execution = fixture.orchestrator.executeFile(call, fixture.executeFilePath);
  await campaignStarted.promise;
  const peer = await fixture.orchestrator.executeCommand("execute", call, "peer-query", {});
  assert.equal(peer.success, true);
  assert.deepEqual(fixture.commands, ["behavior.registry.manifest", "behavior.campaign.start", "peer-query"]);
  continueCampaign.resolve();
  assert.equal((await execution).success, true);
});

test("RBT execute-file closes failed history and attempts cleanup after a thrown command", async (t) => {
  const fixture = createFixture(t);
  const histories = new RbtCampaignExecutionHistoryStore();
  histories.start();
  t.after(() => histories.stop());
  const ready: string[] = [];
  fixture.scope.eventBus.subscribe(RbtEvents.history.ready, (event) => {
    if (RbtEvents.history.ready.is(event)) ready.push(event.payload.status);
  });
  fixture.onCommand = async (command) => {
    if (command === "behavior.trigger.invoke") throw new Error("transport disconnected");
  };
  assert.equal((await fixture.orchestrator.executeFile(call, fixture.executeFilePath)).success, false);
  assert.deepEqual(fixture.commands.slice(-2), ["behavior.scenario.deactivate", "behavior.campaign.stop"]);
  assert.deepEqual(ready, ["failed"]);
  const history = JSON.parse(readFileSync(join(fixture.scope.workflow.agentPaths("executor").artifactRoot, "history", "001.json"), "utf8"));
  assert.equal(history.status, "failed");
  assert.equal(history.commands[2].status, "failed");
  assert.ok(history.endedAt);
});

test("RBT target loss closes local history without claiming remote cleanup succeeded", async (t) => {
  const fixture = createFixture(t);
  const histories = new RbtCampaignExecutionHistoryStore();
  histories.start();
  t.after(() => histories.stop());
  fixture.scope.eventBus.subscribe(RbtEvents.campaign.command, async (event) => {
    if (!RbtEvents.campaign.command.is(event)) return;
    if (event.payload.request.type !== "behavior.scenario.activate") return;
    const target = fixture.base.execution.current(request);
    assert.ok(target.ok);
    await fixture.base.execution.ensureStopped(request, target.identity);
  });
  assert.equal((await fixture.orchestrator.executeFile(call, fixture.executeFilePath)).success, false);
  const history = JSON.parse(readFileSync(join(fixture.scope.workflow.agentPaths("executor").artifactRoot, "history", "001.json"), "utf8"));
  assert.equal(history.status, "failed");
  assert.equal(history.commands.at(-1).request.type, "behavior.campaign.stop");
  assert.equal(history.commands.at(-1).status, "failed");
  assert.deepEqual(fixture.operations, ["identify", "launch", "shutdown"]);
});

test("RBT execute-file fails after target shutdown without relaunching its old campaign", async (t) => {
  const fixture = createFixture(t);
  fixture.scope.eventBus.subscribe(RbtEvents.campaign.start, async () => {
    const target = fixture.base.execution.current(request);
    assert.ok(target.ok);
    assert.ok((await fixture.base.execution.ensureStopped(request, target.identity)).ok);
  });
  const execution = await fixture.orchestrator.executeFile(call, fixture.executeFilePath);
  assert.equal(execution.success, false);
  assert.match(execution.contentItems[0]!.text, /execution_target_not_started/);
  assert.deepEqual(fixture.commands, ["behavior.registry.manifest", "behavior.campaign.start"]);
  assert.deepEqual(fixture.operations, ["identify", "launch", "shutdown"]);
});

test("RBT quiesce waits for execute-file event delivery outside the command queue", async (t) => {
  const fixture = createFixture(t);
  const campaignStarted = commandGate();
  const continueCampaign = commandGate();
  fixture.scope.eventBus.subscribe(RbtEvents.campaign.start, async () => {
    campaignStarted.resolve();
    await continueCampaign.promise;
  });
  const execution = fixture.orchestrator.executeFile(call, fixture.executeFilePath);
  await campaignStarted.promise;
  let drained = false;
  const stopped = fixture.orchestrator.quiesce().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  continueCampaign.resolve();
  assert.equal((await execution).success, false);
  await stopped;
  assert.equal(drained, true);
  assert.deepEqual(fixture.commands, ["behavior.registry.manifest", "behavior.campaign.start"]);
});

const request = { transport: "adb", platform: "android", appId: "test.app" };
const selection = { transport: "adb", platform: { type: "android", version: "1" } };
const call: ScoutDomainDynamicToolCall = {
  input: { threadId: "thread", turnId: "turn", callId: "call", namespace: "rbt_behavior", tool: "JarvisBehavior", arguments: {} },
  caller: { agentId: "executor", role: "executor", phase: "execute", threadId: "thread" },
};

function commandGate(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function createFixture(t: TestContext) {
  const eventBus = new InMemoryEventBus();
  const operations: string[] = [];
  const system: ExecutionPlatformPort = {
    async identify(input = {}, options = {}) {
      operations.push("identify");
      await eventBus.publishAndWait(ExecutionEvents.execution.identifyCompleted, {
        correlationId: options.correlationId ?? "identify", request: input, result: { ok: true, selection },
      });
      return { ok: true, identity: selection.platform };
    },
    async launch(input, options = {}) {
      operations.push("launch");
      await eventBus.publishAndWait(ExecutionEvents.execution.launchCompleted, {
        correlationId: options.correlationId ?? "launch", request: input, result: { ok: true, selection },
      });
      return { ok: true, identity: selection.platform };
    },
    async shutdown(input, options = {}) {
      operations.push("shutdown");
      await eventBus.publishAndWait(ExecutionEvents.execution.shutdownCompleted, {
        correlationId: options.correlationId ?? "shutdown", request: input, result: { ok: true, selection },
      });
      return { ok: true, identity: selection.platform };
    },
  };
  const scope = installTestRunScope(t, { runId: "rbt-connection-queue", eventBus, executionSystem: system });
  const base = scope.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(base instanceof BaseDomain);
  const mount: CodexMount = {
    agentId: "executor", assetCommitId: "asset", mountId: "mount", scoutRoot: scope.scoutRoot,
    mountRoot: scope.runRoot, runRoot: scope.runRoot, agentRoot: join(scope.runRoot, "agents", "executor"), manifestPath: "unused", resourceHash: "test",
    issues: [], readableRoots: [], writableRoots: [], shellTools: [], mcpServers: [], customAgents: [], skills: [], plugins: [],
    agentProfile: {
      config: "test", multiAgent: false, maxThreads: 1, maxDepth: 1, customAgents: [], phases: ["execute"],
      resourceParks: [], shellTools: [], mcpServers: [], plugins: [], readableRoots: [], writableRoots: [],
      model: { id: "test", provider: "test", reasoningEffort: "low", reasoningSummary: "none" },
    },
  };
  const assetCommit: AssetCommit = { ...mount, createdAt: "2026-01-01T00:00:00Z", status: "materialized" };
  scope.setEnvironment({
    agents: { executor: { role: "executor", mount, assetCommit, assetCommitPath: "unused", preflightPath: "unused", preflight: { status: "passed" } } },
    rootAccess: { mountRoots: [], readableRoots: [], writableRoots: [] },
    contextBundle: { contextBundleId: "context", runId: scope.runId, assetCommit, sharedInputs: { mountRoot: scope.runRoot, manifestPath: "unused", resourceHash: "test" } },
  });
  const executeFilePath = join(scope.workflow.agentPaths("executor").artifactRoot, "bdd", "version", "execute-file.json");
  mkdirSync(dirname(executeFilePath), { recursive: true });
  writeFileSync(executeFilePath, JSON.stringify({ commands: [
    { command: "behavior.campaign.start", payload: { campaignId: "campaign", scenarioId: "scenario" } },
    { command: "behavior.scenario.activate", payload: { scenarioId: "scenario", rootId: "node" } },
    { command: "behavior.trigger.invoke", payload: { scenarioId: "scenario", triggerCommandId: "trigger" } },
    { command: "behavior.scenario.deactivate", payload: { scenarioId: "scenario" } },
    { command: "behavior.campaign.stop", payload: { campaignId: "campaign" } },
  ] }));
  const host = new HostCommandExecutor();
  t.mock.method(host, "run", async () => ({
    status: "completed", exitCode: 0, stdout: JSON.stringify({ connected: true, endpoint: "ws://test" }), stderr: "", durationMs: 0,
  }));
  let links = 0;
  const websocket = new JarvisWebSocketTool(host, (input) => {
    links += 1;
    return {
      identity: input.identity,
      async prepare() { return { ok: true, launchParameters: {}, hostCommands: [] }; },
      async connect() { return { ok: true, endpoint: "ws://test", hostCommands: [] }; },
      async close() {},
    };
  });
  const store = new JarvisBehaviorToolStore();
  const runners = {
    execute: new JarvisBehaviorCommandRunner("execute", "unused", [], store),
    review: new JarvisBehaviorCommandRunner("review", "unused", [], store),
  };
  const commands: string[] = [];
  const fixture = {
    scope, base, websocket, executeFilePath, operations, commands, linksCreated: () => links,
    onCommand: async (_command: string, _execution: BehaviorCommandExecution): Promise<BehaviorCommandExecution | void> => {},
    orchestrator: new JarvisBehaviorOrchestrator(() => request, {
      execute: new JarvisBehaviorWebSocketLinker("execute", "unused", [], websocket),
      review: new JarvisBehaviorWebSocketLinker("review", "unused", [], websocket),
    }, runners, new JarvisBehaviorExecuteFileRunner(store), store),
  };
  for (const runner of Object.values(runners)) {
    t.mock.method(runner, "run", async (_call: ScoutDomainDynamicToolCall, command: string, payload: Record<string, AgentJsonValue>) => {
      commands.push(command);
      const execution: BehaviorCommandExecution = {
        status: "completed", hostCommands: [], startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00Z",
        request: { type: command, version: 1, correlationId: String(commands.length), payload },
        result: { type: "behavior.command.result", version: 1, correlationId: String(commands.length), status: "ok", code: "ok", payload: command === "behavior.registry.manifest" ? {
          manifest: { nodes: [{ id: "node" }], variants: [], sources: [], triggerCommands: [{ triggerCommandId: "trigger", relatedBehaviorId: "node" }] },
        } : {} },
      };
      return await fixture.onCommand(command, execution) ?? execution;
    });
  }
  fixture.orchestrator.start();
  t.after(async () => { await fixture.orchestrator.quiesce(); await websocket.stop(); });
  return fixture;
}
