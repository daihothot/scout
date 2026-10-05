import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { agent } from "../../src/agent/context/agent-attachments.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import type { Logger } from "../../src/core/logging/index.js";
import { WorkflowEvents } from "../../src/core/workflow/index.js";
import { WorkflowCreationRolledBackError } from "../../src/core/workflow/transition/workflow-creating-transition.js";
import { AgentStepStore } from "../../src/agent/step/agent-step-store.js";
import { AgentOrchestrator } from "../../src/agent/orchestration/agent-orchestrator.js";
import type { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/protocol/port.js";
import {
  ExecutionStage,
  DomainStage,
  RunRuntimeStage,
  RunScopeStage,
  OrchestratorStage,
  AuthorizationStage,
  RunStageExecutor,
  type RunStage,
} from "../../src/run/lifecycle/index.js";
import {
  currentRunScope,
  RunScope,
} from "../../src/run/run-scope.js";
import { RunEvents } from "../../src/run/events/index.js";
import { ScoutExecutionSystem } from "../../src/execution/scout-execution-system.js";
import { BaseDomain, ScoutDomainId } from "../../src/domain/index.js";
import { RbtDomain } from "../../src/domain/domains/rbt/index.js";
import { SystemEvents } from "../../src/system/events/index.js";
import {
  createTestRunPersistence,
  createDefaultTestGraph,
} from "../helpers/run-persistence.js";

test("RunScopeStage installs the locator without constructing Agent runtime and releases the scope", async (t) => {
  const runId = "boot-run-scope-test";
  let terminationReason: string | undefined;
  const eventBus = new InMemoryEventBus();
  const scope = new RunScope({
    runId,
    scoutRoot: "/repo",
    logger: noopLogger(),
    eventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    ...await createTestRunPersistence(t, runId, "/repo", eventBus),
    terminate: async (reason) => {
      terminationReason = reason;
    },
  });
  const stage = new RunScopeStage(scope);

  assert.equal(stage.scopeCreated, false);
  await stage.start();

  assert.equal(stage.scopeCreated, true);
  assert.equal(currentRunScope(), stage.scope);
  assert.equal(stage.scope.runId, runId);
  assert.deepEqual(stage.scope.domainRegistry.list(), []);
  assert.equal(stage.scope.config.root, "/repo/assets/scout/config");
  assert.deepEqual(stage.scope.agentRegistry.listAgents(), []);
  assert.throws(() => stage.scope.agentOrchestrator, /AgentOrchestrator Service is not available/);
  assert.throws(() => stage.scope.appServer, /app-server is not available/);
  assert.throws(() => stage.scope.executionSystem, /execution system is not available/);
  assert.throws(() => stage.scope.environment, /environment is not available/);

  await stage.scope.terminate("test_termination");
  assert.equal(terminationReason, "test_termination");

  await stage.stop();
  assert.throws(() => currentRunScope(), /No active Scout run scope/);
});

test("OrchestratorStage installs one Store and Backend owner and cannot release another Stage's owner", async (t) => {
  const runId = "orchestrator-stage-owner";
  const scopeStage = new RunScopeStage(new RunScope({
    runId, scoutRoot: "/repo", logger: noopLogger(), eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    ...await createTestRunPersistence(t, runId), terminate: async () => undefined,
  }));
  const stage = new OrchestratorStage();
  const otherStage = new OrchestratorStage();
  const authorizationStage = new AuthorizationStage();
  const live = new Set<string>();
  const released: string[] = [];
  const client = {
    onTimeline() { live.add("timeline"); return () => { live.delete("timeline"); released.push("timeline"); }; },
    setDynamicToolCallHandler() { live.add("dynamic-tool"); return () => { live.delete("dynamic-tool"); released.push("dynamic-tool"); }; },
    onServerRequest() { live.add("request"); return () => { live.delete("request"); released.push("request"); }; },
  } as unknown as CodexAppServerClient;
  await scopeStage.start();
  scopeStage.scope.setAppServer(client);
  t.after(async () => {
    await otherStage.stop(); await stage.stop(); await authorizationStage.stop();
    scopeStage.scope.clearAppServer(client); await scopeStage.stop();
  });
  await authorizationStage.start();
  await stage.start();
  const owner = scopeStage.scope.agentOrchestrator;
  const stores = [owner.taskStore, owner.stepStore, owner.humanInputStore, owner.toolCallStore];
  const backends = [owner.timelineBackend, owner.dynamicToolBackend, owner.requestBackend];
  await stage.start();
  assert.equal(scopeStage.scope.agentOrchestrator, owner);
  assert.deepEqual([owner.taskStore, owner.stepStore, owner.humanInputStore, owner.toolCallStore], stores);
  assert.deepEqual([owner.timelineBackend, owner.dynamicToolBackend, owner.requestBackend], backends);
  assert.deepEqual([...live], ["timeline", "dynamic-tool", "request"]);
  assert.equal(scopeStage.scope.workflow.participants.filter((participant) => participant === owner).length, 1);
  assert.equal("taskStore" in scopeStage.scope, false);
  await assert.rejects(otherStage.start(), /already available/);
  await otherStage.stop();
  assert.equal(scopeStage.scope.agentOrchestrator, owner);
  assert.equal(owner.snapshot().stopped, false);
  assert.deepEqual([...live], ["timeline", "dynamic-tool", "request"]);
  assert.deepEqual(released, []);
  await stage.stop();
  assert.equal(owner.snapshot().stopped, true);
  assert.equal(scopeStage.scope.workflow.participants.includes(owner), false);
  assert.throws(() => scopeStage.scope.agentOrchestrator, /not available/);
  assert.equal(live.size, 0);
  assert.deepEqual(released, ["request", "dynamic-tool", "timeline"]);
});

test("OrchestratorStage backend startup failure rolls back the owner before downstream stages run", async (t) => {
  const runId = "orchestrator-stage-backend-failure";
  const scopeStage = new RunScopeStage(new RunScope({
    runId, scoutRoot: "/repo", logger: noopLogger(), eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    ...await createTestRunPersistence(t, runId), terminate: async () => undefined,
  }));
  const authorizationStage = new AuthorizationStage();
  const stage = new OrchestratorStage();
  const live = new Set<string>();
  const client = {
    onTimeline() { live.add("timeline"); return () => { live.delete("timeline"); }; },
    setDynamicToolCallHandler() { live.add("dynamic-tool"); return () => { live.delete("dynamic-tool"); }; },
    onServerRequest() { throw new Error("request subscription failed"); },
  } as unknown as CodexAppServerClient;
  await scopeStage.start();
  const scope = scopeStage.scope;
  scope.setAppServer(client);
  t.after(async () => {
    await stage.stop(); await authorizationStage.stop();
    scope.clearAppServer(client); await scopeStage.stop();
  });
  await authorizationStage.start();
  const participants = [...scope.workflow.participants];
  const dispose = t.mock.method(AgentStepStore.prototype, "dispose");
  let downstreamStarted = false;
  const executor = new RunStageExecutor({ runId, logger: noopLogger() });
  executor.registerSerial(stage, { id: "agent-consumer", async start() { downstreamStarted = true; } });
  await assert.rejects(executor.startup(), /request subscription failed/);
  assert.equal(executor.snapshot().status, "failed");
  assert.equal(downstreamStarted, false);
  assert.equal(live.size, 0);
  assert.equal(dispose.mock.callCount(), 1);
  assert.deepEqual(scope.workflow.participants, participants);
  assert.throws(() => scope.agentOrchestrator, /not available/);
});

test("OrchestratorStage keeps its owner when a Backend fails to release and retries cleanup", async (t) => {
  const runId = "orchestrator-stage-backend-cleanup";
  const scopeStage = new RunScopeStage(new RunScope({
    runId, scoutRoot: "/repo", logger: noopLogger(), eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    ...await createTestRunPersistence(t, runId), terminate: async () => undefined,
  }));
  const authorizationStage = new AuthorizationStage();
  const stage = new OrchestratorStage();
  let rejectCleanup = true;
  const live = new Set<string>();
  const client = {
    onTimeline() { live.add("timeline"); return () => { live.delete("timeline"); }; },
    setDynamicToolCallHandler() {
      live.add("dynamic-tool");
      return () => {
        if (rejectCleanup) throw new Error("dynamic cleanup failed");
        live.delete("dynamic-tool");
      };
    },
    onServerRequest() { live.add("request"); return () => { live.delete("request"); }; },
  } as unknown as CodexAppServerClient;
  await scopeStage.start();
  const scope = scopeStage.scope;
  scope.setAppServer(client);
  t.after(async () => {
    rejectCleanup = false; await stage.stop(); await authorizationStage.stop();
    scope.clearAppServer(client); await scopeStage.stop();
  });
  await authorizationStage.start();
  await stage.start();
  const owner = scope.agentOrchestrator;
  const backend = owner.dynamicToolBackend;
  await assert.rejects(stage.stop(), /AgentOrchestrator cleanup failed/);
  assert.equal(scope.agentOrchestrator, owner);
  assert.equal(scope.workflow.participants.includes(owner), true);
  assert.equal(owner.dynamicToolBackend, backend);
  assert.deepEqual([...live], ["dynamic-tool"]);
  rejectCleanup = false;
  await stage.stop();
  assert.equal(live.size, 0);
  assert.equal(scope.workflow.participants.includes(owner), false);
  assert.throws(() => scope.agentOrchestrator, /not available/);
});

for (const drainFails of [false, true]) {
  test(`OrchestratorStage waits for ${drainFails ? "failed" : "successful"} Workflow quiescence before disposing Agent Stores`, async (t) => {
    const runId = `orchestrator-stage-drain-${drainFails}`;
    const scopeStage = new RunScopeStage(new RunScope({
      runId, scoutRoot: "/repo", logger: noopLogger(), eventBus: new InMemoryEventBus(),
      interactionPort: new NoopRuntimeInteractionPort(),
      ...await createTestRunPersistence(t, runId), terminate: async () => undefined,
    }));
    const stage = new OrchestratorStage();
    await scopeStage.start();
    // Store disposal ordering is independent of native protocol subscriptions.
    t.mock.method(AgentOrchestrator.prototype, "startBackends", () => undefined);
    await stage.start();
    const scope = scopeStage.scope;
    const owner = scope.agentOrchestrator;
    let release!: () => void;
    const drained = new Promise<void>((resolve) => { release = resolve; });
    const observed: string[] = [];
    const quiesce = scope.workflow.quiesce.bind(scope.workflow);
    const failure = new Error("Workflow transition failed after draining");
    t.mock.method(scope.workflow, "quiesce", async () => {
      await drained;
      await quiesce();
      if (drainFails) throw failure;
    }, { times: 1 });
    for (const [name, store] of [
      ["step", owner.stepStore], ["human", owner.humanInputStore], ["tool", owner.toolCallStore],
    ] as const) {
      const dispose = store.dispose.bind(store);
      t.mock.method(store, "dispose", () => { observed.push(name); dispose(); });
    }
    t.after(async () => { release(); await stage.stop(); await scopeStage.stop(); });
    const stopping = stage.stop();
    const stopped = drainFails ? assert.rejects(stopping, (error) => error === failure) : stopping;
    await Promise.resolve();
    assert.deepEqual(observed, []);
    assert.equal(scope.agentOrchestrator, owner);
    release();
    await stopped;
    assert.deepEqual(observed, ["step", "human", "tool"]);
    assert.throws(() => scope.agentOrchestrator, /not available/);
  });
}

test("OrchestratorStage releases its owner after Store subscription startup fails", async (t) => {
  const runId = "orchestrator-stage-startup-failure";
  const scopeStage = new RunScopeStage(new RunScope({
    runId, scoutRoot: "/repo", logger: noopLogger(), eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    ...await createTestRunPersistence(t, runId), terminate: async () => undefined,
  }));
  const stage = new OrchestratorStage();
  await scopeStage.start();
  t.after(async () => { await stage.stop(); await scopeStage.stop(); });
  t.mock.method(AgentStepStore.prototype, "start", () => { throw new Error("Store subscription failed"); });
  await assert.rejects(stage.start(), /Store subscription failed/);
  const owner = scopeStage.scope.agentOrchestrator;
  assert.equal(owner.snapshot().stopped, true);
  assert.equal(scopeStage.scope.workflow.participants.includes(owner), true);
  await assert.rejects(stage.start(), /startup cleanup is pending/);
  await stage.stop();
  assert.equal(scopeStage.scope.workflow.participants.includes(owner), false);
  assert.throws(() => scopeStage.scope.agentOrchestrator, /not available/);
});

test("DomainStage creates, installs, starts, and clears both Run Domains", async (t) => {
  const runId = "run-domain-stage";
  const eventBus = new InMemoryEventBus();
  const scope = new RunScope({
    runId,
    scoutRoot: process.cwd(),
    logger: noopLogger(),
    eventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    ...await createTestRunPersistence(
      t,
      runId,
      process.cwd(),
      eventBus,
      undefined,
      createDefaultTestGraph("rbt"),
    ),
    terminate: async () => undefined,
  });
  const scopeStage = new RunScopeStage(scope);
  const executionStage = new ExecutionStage(async () => ScoutExecutionSystem.start({
    async start() {},
    async invoke() {
      return {
        ok: false,
        code: "test_execution_unavailable",
        message: "Execution is not used by DomainStage lifecycle assertions.",
      };
    },
    async close() {},
  }, eventBus));
  const domainStage = new DomainStage();
  t.after(async () => {
    await domainStage.stop();
    await executionStage.stop();
    await scopeStage.stop();
  });

  await scopeStage.start();
  await executionStage.start();
  await domainStage.start();

  assert.equal(
    scope.domainRegistry.get(ScoutDomainId.Rbt).description.id,
    ScoutDomainId.Rbt,
  );
  assert.equal(
    scope.domainRegistry.get(ScoutDomainId.Base).description.id,
    ScoutDomainId.Base,
  );

  await domainStage.stop();
  assert.deepEqual(scope.domainRegistry.list(), []);

  await executionStage.stop();
  await scopeStage.stop();
});

for (const preparationFails of [false, true]) {
  test(`DomainStage drains ${preparationFails ? "a failed" : "a committing"} Workflow before stopping any Domain`, async (t) => {
    const runId = `run-domain-stage-drain-${preparationFails}`;
    const eventBus = new InMemoryEventBus();
    const scope = new RunScope({
      runId,
      scoutRoot: process.cwd(),
      logger: noopLogger(),
      eventBus,
      interactionPort: new NoopRuntimeInteractionPort(),
      ...await createTestRunPersistence(
        t,
        runId,
        process.cwd(),
        eventBus,
        undefined,
        createDefaultTestGraph("rbt"),
      ),
      terminate: async () => undefined,
    });
    const scopeStage = new RunScopeStage(scope);
    const executionStage = new ExecutionStage(async () => ScoutExecutionSystem.start({
      async start() {},
      async invoke() {
        throw new Error("Workflow boundary lifecycle tests must not invoke execution.");
      },
      async close() {},
    }, eventBus));
    const domainStage = new DomainStage();
    const orchestratorStage = new OrchestratorStage();
    let releasePreparation!: () => void;
    const gate = new Promise<void>((resolve) => { releasePreparation = resolve; });
    let announcePreparation!: () => void;
    const enteredPreparation = new Promise<void>((resolve) => { announcePreparation = resolve; });
    let stopping: Promise<void> | undefined;
    t.after(async () => {
      releasePreparation();
      await stopping?.catch(() => undefined);
      await domainStage.stop();
      await orchestratorStage.stop();
      await executionStage.stop();
      await scopeStage.stop();
    });
    await scopeStage.start();
    // This fixture exercises Domain boundary draining, not native protocol subscriptions.
    t.mock.method(AgentOrchestrator.prototype, "startBackends", () => undefined);
    await orchestratorStage.start();
    await executionStage.start();
    await domainStage.start();
    await eventBus.publishAndWait(RunEvents.runtime.attached, {
      mode: "start",
      attachedAt: new Date().toISOString(),
      processId: process.pid,
    });
    const previousWorkflow = scope.workflow.snapshot()!;
    const previousRoot = scope.workflow.journalRoot;
    for (let phase = 0; phase < 4; phase += 1) await scope.workflow.advance("completed");
    const nextRoot = join(scope.runRoot, "workflows", "test--workflow-002", "journal");

    assert.equal(scope.workflow.snapshot(), undefined);
    const domains = scope.domainRegistry.list();
    const observed: string[] = [];
    const base = scope.domainRegistry.get(ScoutDomainId.Base);
    const validation = scope.domainRegistry.get(ScoutDomainId.Rbt);
    assert.ok(base instanceof BaseDomain);
    assert.ok(validation instanceof RbtDomain);
    const stopBase = base.stop.bind(base);
    t.mock.method(base, "stop", () => {
      observed.push("stop:base");
      stopBase();
    });
    const stopValidation = validation.stop.bind(validation);
    t.mock.method(validation, "stop", async () => {
      observed.push("stop:validation");
      await stopValidation();
    });
    const prepare = base.recordObject.prepare;
    const preparationError = new Error("Domain Workflow preparation failed during shutdown");
    t.mock.method(base.recordObject, "prepare", async (root: string) => {
      observed.push("prepare");
      announcePreparation();
      await gate;
      if (preparationFails) throw preparationError;
      const change = prepare.call(base.recordObject, root);
      eventBus.subscribe(WorkflowEvents.workflow.committing, () => { observed.push("commit"); });
      return change;
    });
    const submit = (text: string) => eventBus.publishAndWait(SystemEvents.interaction.userMessageSubmitted, {
      messageId: text,
      text,
      attachment: agent.turn.message(text),
      submittedAt: new Date().toISOString(),
    });
    const input = scope.workflow.startWorkflow("test");
    const inputDone = preparationFails
      ? assert.rejects(input, (error) => error instanceof WorkflowCreationRolledBackError && error.cause === preparationError)
      : input;
    await enteredPreparation;
    stopping = domainStage.stop();
    const stopped = preparationFails
      ? assert.rejects(stopping, (error) => error instanceof WorkflowCreationRolledBackError && error.cause === preparationError)
      : stopping;
    let stopSettled = false;
    void stopping.then(() => { stopSettled = true; }, () => { stopSettled = true; });
    await Promise.resolve();
    assert.equal(stopSettled, false);
    assert.deepEqual(observed, ["prepare"]);
    assert.deepEqual(scope.domainRegistry.list(), domains);
    await assert.rejects(submit("rejected-during-stop"), /Workflow is stopping/);
    assert.equal(scope.workflow.readEvents().some((event) => (
      SystemEvents.interaction.userMessageSubmitted.is(event)
      && event.payload.text === "rejected-during-stop"
    )), false);
    assert.deepEqual(observed, ["prepare"]);

    releasePreparation();
    await inputDone;
    await stopped;
    assert.equal(stopSettled, true);
    assert.deepEqual(observed, preparationFails
      ? ["prepare", "stop:validation", "stop:base"]
      : ["prepare", "commit", "stop:validation", "stop:base"]);
    assert.deepEqual(scope.domainRegistry.list(), []);
    if (preparationFails) {
      assert.equal(scope.workflow.snapshot(), undefined);
      assert.equal(existsSync(join(previousRoot, "scout.journal")), true);
      assert.equal(existsSync(nextRoot), false);
    } else {
      assert.equal(scope.workflow.snapshot()?.workflowId, "workflow-002");
      assert.equal(scope.workflow.journalRoot, nextRoot);
      assert.equal(existsSync(join(previousRoot, ".base.lock")), false);
      assert.equal(existsSync(join(nextRoot, ".base.lock")), false);
    }
  });
}

test("ExecutionStage installs and clears the run-scoped system without probing a platform", async (t) => {
  const runId = "run-execution-stage";
  const eventBus = new InMemoryEventBus();
  const scope = new RunScope({
    runId,
    scoutRoot: process.cwd(),
    logger: noopLogger(),
    eventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    ...await createTestRunPersistence(t, runId, "/repo", eventBus),
    terminate: async () => undefined,
  });
  const scopeStage = new RunScopeStage(scope);
  const executionStage = new ExecutionStage(async () => ScoutExecutionSystem.start({
    async start() {},
    async invoke() {
      throw new Error("ExecutionStage must not probe a platform during startup.");
    },
    async close() {},
  }));

  await scopeStage.start();
  assert.throws(() => scope.executionSystem, /execution system is not available/);

  await executionStage.start();
  const system = scope.executionSystem;
  assert.equal(typeof system.launch, "function");
  assert.equal(typeof system.shutdown, "function");

  await executionStage.stop();
  assert.throws(() => scope.executionSystem, /execution system is not available/);
  await scopeStage.stop();
});

test("RunScopeStage remains available until every dependent stage stops", async (t) => {
  const logger = noopLogger();
  const boot = new RunStageExecutor({
    runId: "boot-run-scope-order",
    logger,
  });
  const eventBus = new InMemoryEventBus();
  const scope = new RunScope({
    runId: "boot-run-scope-order",
    scoutRoot: process.cwd(),
    logger,
    eventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    ...await createTestRunPersistence(t, "boot-run-scope-order", "/repo", eventBus),
    terminate: (reason) => boot.terminate(reason),
  });
  const scopeStage = new RunScopeStage(scope);
  const observed: string[] = [];
  const dependentStage: RunStage = {
    id: "dependent",
    async start() {
      observed.push(`start:${currentRunScope().runId}`);
    },
    async stop() {
      observed.push(`stop:${currentRunScope().runId}`);
    },
  };
  boot.registerSerial(scopeStage, dependentStage);

  await boot.startup();
  await boot.terminate("test_cleanup");

  assert.deepEqual(observed, [
    "start:boot-run-scope-order",
    "stop:boot-run-scope-order",
  ]);
  assert.throws(() => currentRunScope(), /No active Scout run scope/);
});

test("RunScopeStage does not record an attachment when another run owns the process scope", async (t) => {
  const firstEventBus = new InMemoryEventBus();
  const firstPersistence = await createTestRunPersistence(
    t,
    "run-scope-owner",
    "/repo",
    firstEventBus,
  );
  const first = new RunScopeStage(new RunScope({
    runId: "run-scope-owner",
    scoutRoot: process.cwd(),
    logger: noopLogger(),
    eventBus: firstEventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    ...firstPersistence,
    terminate: async () => undefined,
  }));
  const secondEventBus = new InMemoryEventBus();
  const secondPersistence = await createTestRunPersistence(
    t,
    "run-scope-rejected",
    "/repo",
    secondEventBus,
  );
  const second = new RunScopeStage(new RunScope({
    runId: "run-scope-rejected",
    scoutRoot: process.cwd(),
    logger: noopLogger(),
    eventBus: secondEventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    ...secondPersistence,
    terminate: async () => undefined,
  }));

  await first.start();
  try {
    await assert.rejects(second.start(), /Run scope already installed: run-scope-owner/);
    assert.equal(currentRunScope(), first.scope);
    assert.equal(
      secondPersistence.journal.readAll().some((event) =>
        RunEvents.runtime.attached.is(event)
      ),
      false,
    );
    assert.equal(secondPersistence.manifestStore.read().runtime.status, "created");
  } finally {
    await second.stop();
    await first.stop();
  }
});

test("RunScopeStage detaches normally after a previous Journal write failure", async (t) => {
  const runId = "run-scope-journal-failed";
  const eventBus = new InMemoryEventBus();
  const persistence = await createTestRunPersistence(t, runId, "/repo", eventBus);
  const scopeStage = new RunScopeStage(new RunScope({
    runId,
    scoutRoot: process.cwd(),
    logger: noopLogger(),
    eventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    ...persistence,
    terminate: async () => undefined,
  }));
  const runtimeStage = new RunRuntimeStage("start");
  let runtimeStopEvents = 0;
  eventBus.subscribe(RunEvents.runtime.interrupted, () => {
    runtimeStopEvents += 1;
  });
  eventBus.subscribe(RunEvents.runtime.detached, () => {
    runtimeStopEvents += 1;
  });
  await scopeStage.start();
  await runtimeStage.start();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await eventBus.publishAndWait(RunEvents.runtime.attached, circular);
  assert.equal(persistence.workflow.journalFailed, true);

  await runtimeStage.stop("test_cleanup");
  await scopeStage.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(runtimeStopEvents, 1);
  assert.deepEqual(persistence.manifestStore.read().runtime, {
    status: "detached",
    reason: "test_cleanup",
  });
  assert.throws(() => currentRunScope(), /No active Scout run scope/);
});

function noopLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}
