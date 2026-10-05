import { RbtDomainProjector } from "../../src/domain/domains/rbt/index.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowEvents } from "../../src/core/workflow/index.js";
import type { ShellToolContract } from "../../src/asset-store/contracts/resources.js";
import { buildWorkflow } from "../../src/asset-store/builders/workflow-builder.js";
import { AgentDynamicToolBackend } from "../../src/agent/backend/dynamic-tool/agent-dynamic-tool-backend.js";
import { attachments } from "../../src/agent/context/attachments.js";
import { CoordinatorContextTags } from "../../src/agent/runner/coordinator/coordinator-attachments.js";
import type { ScoutAgent } from "../../src/agent/core/scout-agent.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import type { SendAgentMessageInput } from "../../src/agent/task/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { Result } from "../../src/core/result.js";
import { createGraphData, Graph } from "../../src/core/workflow/index.js";
import {
  JarvisWebSocketTool,
  RbtDomain,
  RbtEvents,
  type RbtDomainRuntimeOptions,
} from "../../src/domain/domains/rbt/index.js";
import {
  BaseDomain,
  BaseDomainEvents,
  DomainEvents,
  ExecutionPlatformTool,
  ScoutDomainId,
} from "../../src/domain/index.js";
import {
  ScoutExecutionSystem,
  type ExecutionPlatformIdentity,
  type ExecutionPlatformPort,
  type ExecutionPlatformRequest,
} from "../../src/execution/scout-execution-system.js";
import { AppPilotExecutionHandler } from "../../src/execution/handlers/apppilot/index.js";
import { ExecutionEvents } from "../../src/execution/execution-events.js";
import type { ExecutionHandlerValue } from "../../src/execution/execution-handler.js";
import type { ScoutDomainDynamicToolCall } from "../../src/domain/types.js";
import type { RunEnvironment } from "../../src/run/types.js";
import { currentRunScope, type RunScope } from "../../src/run/run-scope.js";
import { workflowAgentPaths, workflowPaths } from "../../src/core/io/index.js";
import { RunEvents } from "../../src/run/events/index.js";
import { installTestRunScope, createTestGraph } from "../helpers/run-persistence.js";

test("RBT Domain exposes behavior execution and final platform shutdown by Phase", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = new RbtDomain();
  const asset = buildWorkflow(process.cwd(), "rbt");
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-tools",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: new Graph(asset),
    workflowAsset: asset,
  });
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const backend = new AgentDynamicToolBackend();
  assert.deepEqual(backend.dynamicToolsForPhase("execute").map((tool) => tool.name), [
    "ResolveArtifactReference", "SendMessage", "RequestHumanInput", "SubmitTask", "JarvisBehavior",
  ]);
  assert.deepEqual(backend.dynamicToolsForPhase("review").map((tool) => tool.name), [
    "ResolveArtifactReference", "SendMessage", "RequestHumanInput", "SubmitTask", "JarvisBehavior", "ExecutionPlatform",
  ]);
  assert.deepEqual(backend.dynamicToolsForPhase("Synthesis").map((tool) => tool.name), [
    "StartWorkflow", "ResolveArtifactReference", "AssignTask", "SendMessage", "RespondHumanInput", "SubmitPhaseOutcome",
  ]);

  await domain.stop();
  assert.deepEqual(baseDomain(scope).backend.toolDefinitions.map((tool) => tool.name), ["ExecutionPlatform"]);
  assert.deepEqual(domain.backend.toolDefinitions.map((tool) => tool.name), ["JarvisBehavior"]);
});

test("RBT schema follows execute roles, including renamed workers and a reviewer without codebase access", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain();
  const graph = rbtGraph(eventBus).snapshot();
  const runtimeGraph = createTestGraph({
    ...graph,
    roles: graph.roles.map((role) => ({ ...role, name: role.name === "executor" ? "operator" : role.name })),
    phases: graph.phases.map((phase) => ({ ...phase, roles: phase.roles.map((role) => role === "executor" ? "operator" : role) })),
  });
  const scope = await installTestRunScope(t, { runId: "renamed-rbt-worker", scoutRoot: process.cwd(), eventBus, domain, runtimeGraph, executionSystem: fakeExecutionSystem() });
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    operator: { ...roleRoots(scope.runRoot, "operator"), readableRoots: [codebaseRoot], shellTools: [] },
    reviewer: { ...roleRoots(scope.runRoot, "reviewer"), readableRoots: [], shellTools: [] },
  }));
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());
  for (const [role, phase, command] of [
    ["operator", "execute", "behavior.registry.nodes"],
    ["reviewer", "review", "behavior.campaign.query"],
  ]) {
    const result = await domain.backend.handleDynamicToolCall(dynamicCall({
      callId: role, namespace: "rbt_behavior", tool: "JarvisBehavior", arguments: { command, payload: {} }, role, phase,
    }));
    assert.equal(result?.success, true, result?.contentItems[0]?.text);
  }
});

test("RBT rejects conflicting schema bindings across execute roles", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain();
  const graph = rbtGraph(eventBus).snapshot();
  const runtimeGraph = createTestGraph({
    ...graph, roles: [...graph.roles, { name: "operator", phases: ["execute"] }],
    phases: graph.phases.map((phase) => phase.name === "execute" ? { ...phase, roles: [...phase.roles, "operator"] } : phase),
  });
  const scope = await installTestRunScope(t, { runId: "ambiguous-rbt-schema", scoutRoot: process.cwd(), eventBus, domain, runtimeGraph, executionSystem: fakeExecutionSystem() });
  scope.setEnvironment(rbtEnvironment(scope.runId, Object.fromEntries(["executor", "operator"].map((role) => [role, {
    ...roleRoots(scope.runRoot, role), readableRoots: [installBehaviorSchema(join(scope.runRoot, role))], shellTools: [],
  }]))));
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());
  const result = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "ambiguous", namespace: "rbt_behavior", tool: "JarvisBehavior",
    arguments: { command: "behavior.registry.nodes", payload: {} }, role: "executor",
  }));
  assert.equal(result?.success, false);
  assert.match(result?.contentItems[0]?.text ?? "", /behavior_schema_ambiguous/);
});

test("RBT restores every missing history after Agent state restoration and does not redeliver on another restore", async (t) => {
  const domain = new RbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-history-recovery",
    scoutRoot: process.cwd(),
    domain,
  });
  await domain.start();
  await domain.run();
  const readyHistories = [1, 2].map((runtimeSequence) => ({
    bddId: "account", targetVersion: "1.0", platform: { type: "unity-editor", version: "test" },
    executeFileDigest: `sha256:${"a".repeat(64)}`, executorHistoryDigest: `sha256:${"b".repeat(64)}`,
    executorHistoryRef: `scout-artifact://workflow-001/executor/history/00${runtimeSequence}.json`,
    executeFileRef: "scout-artifact://workflow-001/executor/pack/execute-file.json",
    runtimeSequence,
    campaignId: `campaign-${runtimeSequence}`,
    scenarioId: "scenario",
    status: "completed" as const,
    agentId: "executor",
    role: "executor",
  }));
  const occurredAt = "2026-09-27T00:00:01.000Z";
  for (const history of readyHistories) {
    await scope.eventBus.publishAndWait(RbtEvents.history.ready, history, { occurredAt });
  }
  const beforeRestore = domain.recordObject.read();
  await domain.restore(scope.workflow.snapshot()!);
  assert.deepEqual(scope.agentRegistry.listAgents(), []);

  const deliveries: SendAgentMessageInput[] = [];
  let messagesRestored = false;
  scope.agentRegistry.registerAgent({
    agentId: "coordinator",
    role: "coordinator",
    async sendMessage(input: SendAgentMessageInput) {
      assert.equal(messagesRestored, true);
      assert.ok(input.delivery);
      deliveries.push(input);
      await scope.eventBus.publishAndWait(AgentEvents.message.queued, {
        agentId: "coordinator",
        messageId: input.delivery.messageId,
        body: input.message,
        queuedAt: input.delivery.queuedAt,
        deliveryMode: input.deliveryMode,
      }, { occurredAt: input.delivery.queuedAt });
      return Result.ok(undefined);
    },
  } as unknown as ScoutAgent);
  assert.equal(deliveries.length, 0);
  messagesRestored = true;
  await scope.eventBus.publishAndWait(RunEvents.runtime.ready, { mode: "resume", readyAt: occurredAt });
  assert.deepEqual(deliveries.map((delivery) => delivery.delivery), [
    { messageId: `${scope.runId}-workflow-001-rbt-history-executor-1`, queuedAt: occurredAt },
    { messageId: `${scope.runId}-workflow-001-rbt-history-executor-2`, queuedAt: occurredAt },
  ]);
  assert.ok(deliveries.every((delivery) => delivery.deliveryMode === "queued"));
  assert.match(deliveries[0]!.message, /campaign_id: campaign-1/);
  assert.match(deliveries[1]!.message, /campaign_id: campaign-2/);
  assert.deepEqual(domain.recordObject.read(), beforeRestore);
  assert.equal(scope.workflow.readEvents().filter((event) => AgentEvents.message.queued.is(event)).length, 2);
  assert.equal(scope.workflow.readEvents().some((event) => RbtEvents.history.ready.is(event)), false);

  await domain.restore(scope.workflow.snapshot()!);
  await scope.eventBus.publishAndWait(RunEvents.runtime.ready, { mode: "resume", readyAt: occurredAt });
  assert.equal(deliveries.length, 2);
  await scope.eventBus.publishAndWait(RunEvents.runtime.ready, { mode: "resume", readyAt: occurredAt });
  assert.equal(deliveries.length, 2);

  const liveAt = "2026-09-27T00:01:01.000Z";
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, {
    ...readyHistories[0]!, runtimeSequence: 3,
  }, { occurredAt: liveAt });
  assert.deepEqual(deliveries[2]!.delivery, {
    messageId: `${scope.runId}-workflow-001-rbt-history-executor-3`,
    queuedAt: liveAt,
  });
});

test("RBT recovery skips persisted queued and consumed delivery identities", async (t) => {
  const domain = new RbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-history-accepted",
    scoutRoot: process.cwd(),
    domain,
  });
  await domain.start();
  await domain.run();
  const occurredAt = "2026-09-27T00:00:01.000Z";
  for (const runtimeSequence of [1, 2, 3]) {
    await scope.eventBus.publishAndWait(RbtEvents.history.ready, {
      bddId: "account", targetVersion: "1.0", platform: { type: "unity-editor", version: "test" },
      executeFileDigest: `sha256:${"a".repeat(64)}`, executorHistoryDigest: `sha256:${"b".repeat(64)}`,
      executorHistoryRef: `scout-artifact://workflow-001/executor/history/${runtimeSequence}.json`,
      executeFileRef: "scout-artifact://workflow-001/executor/pack/execute-file.json",
      runtimeSequence,
      campaignId: "campaign",
      scenarioId: "scenario",
      status: "completed",
      agentId: "executor",
      role: "executor",
    }, { occurredAt });
  }
  await scope.eventBus.publishAndWait(AgentEvents.message.queued, {
    agentId: "coordinator-runtime",
    messageId: `${scope.runId}-workflow-001-rbt-history-executor-1`,
    body: "already accepted",
    queuedAt: "2026-09-27T00:00:02.000Z",
  });
  await scope.eventBus.publishAndWait(AgentEvents.message.consumed, {
    agentId: "coordinator-runtime",
    messageId: `${scope.runId}-workflow-001-rbt-history-executor-2`,
    stepId: "coordinator-step-1",
    consumedAt: "2026-09-27T00:00:03.000Z",
  });
  await scope.eventBus.publishAndWait(AgentEvents.message.queued, {
    agentId: "another-agent",
    messageId: `${scope.runId}-workflow-001-rbt-history-executor-3`,
    body: "not accepted by the Coordinator",
    queuedAt: "2026-09-27T00:00:04.000Z",
  });
  const deliveries: SendAgentMessageInput[] = [];
  await domain.restore(scope.workflow.snapshot()!);
  scope.agentRegistry.registerAgent({
    agentId: "coordinator-runtime",
    role: "coordinator",
    async sendMessage(input: SendAgentMessageInput) {
      deliveries.push(input);
      return Result.ok(undefined);
    },
  } as unknown as ScoutAgent);
  await scope.eventBus.publishAndWait(RunEvents.runtime.ready, { mode: "resume", readyAt: occurredAt });
  assert.deepEqual(deliveries.map((delivery) => delivery.delivery?.messageId), [
    `${scope.runId}-workflow-001-rbt-history-executor-3`,
  ]);
});

test("RBT history delivery separates identical sequence numbers across Workflows for the same Coordinator", async (t) => {
  const domain = new RbtDomain();
  const scope = await installTestRunScope(t, { runId: "rbt-cross-workflow-history", scoutRoot: process.cwd(), domain });
  await domain.start();
  await domain.run();
  const accepted = new Map<string, SendAgentMessageInput>();
  const coordinator = {
    agentId: "coordinator", role: "coordinator",
    threadSnapshot: {
      agentId: "coordinator", role: "coordinator", phases: ["Synthesis"], contextBundleId: "shared-context",
      threadId: "same-coordinator-thread", createdAt: new Date().toISOString(), status: "active",
      startInput: { cwd: scope.runRoot, ephemeral: false, permissions: "scout-coordinator", approvalPolicy: "never" },
      startResponse: {},
    },
    snapshot: () => ({ agentId: "coordinator", pendingMessageCount: 0 }),
    async sendMessage(input: SendAgentMessageInput) {
      assert.ok(input.delivery);
      const existing = accepted.get(input.delivery.messageId);
      if (existing) {
        assert.deepEqual(input, existing, "a repeated delivery identity must retain its original body");
        return Result.ok(undefined);
      }
      accepted.set(input.delivery.messageId, input);
      await scope.eventBus.publishAndWait(AgentEvents.message.queued, {
        agentId: "coordinator", messageId: input.delivery.messageId, body: input.message,
        queuedAt: input.delivery.queuedAt, deliveryMode: input.deliveryMode,
      });
      await scope.eventBus.publishAndWait(AgentEvents.message.consumed, {
        agentId: "coordinator", messageId: input.delivery.messageId, stepId: "consumed-" + accepted.size,
        consumedAt: input.delivery.queuedAt,
      });
      return Result.ok(undefined);
    },
  } as unknown as ScoutAgent;
  scope.agentRegistry.registerAgent(coordinator);
  for (const workflowId of ["workflow-001", "workflow-002"]) {
    assert.equal(scope.workflow.snapshot()?.workflowId, workflowId);
    await scope.eventBus.publishAndWait(RbtEvents.history.ready, {
      bddId: "account", targetVersion: "1.0", platform: { type: "unity-editor", version: "test" },
      executeFileDigest: `sha256:${"a".repeat(64)}`, executorHistoryDigest: `sha256:${"b".repeat(64)}`,
      executorHistoryRef: `scout-artifact://${workflowId}/executor/history/001.json`,
      executeFileRef: `scout-artifact://${workflowId}/executor/execute-file.json`,
      runtimeSequence: 1, campaignId: "same-campaign", scenarioId: "same-scenario",
      status: "completed", agentId: "executor", role: "executor",
    });
    await domain.restore(scope.workflow.snapshot()!);
    await scope.eventBus.publishAndWait(RunEvents.runtime.ready, { mode: "resume", readyAt: new Date().toISOString() });
    assert.equal(accepted.size, workflowId === "workflow-001" ? 1 : 2, "restore must not redeliver accepted history");
    if (workflowId === "workflow-001") {
      await scope.workflow.advance("error");

      await scope.workflow.startWorkflow("test");
    }
  }
  assert.deepEqual([...accepted.keys()], [
    `${scope.runId}-workflow-001-rbt-history-executor-1`,
    `${scope.runId}-workflow-002-rbt-history-executor-1`,
  ]);
  assert.ok([...accepted.values()][1]!.message.includes('"workflowId":"workflow-002","agentId":"executor","internalSymbols":["history","001.json"]'));
});

test("RBT repeated restore replaces the previous pending history subscription", async (t) => {
  const domain = new RbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-history-repeated-restore",
    scoutRoot: process.cwd(),
    domain,
  });
  await domain.start();
  await domain.run();
  const history = {
    bddId: "account", targetVersion: "1.0", platform: { type: "unity-editor", version: "test" },
    executeFileDigest: `sha256:${"a".repeat(64)}`, executorHistoryDigest: `sha256:${"b".repeat(64)}`,
    executorHistoryRef: "scout-artifact://workflow-001/executor/history/1.json",
    executeFileRef: "scout-artifact://workflow-001/executor/pack/execute-file.json",
    runtimeSequence: 1,
    campaignId: "campaign",
    scenarioId: "scenario",
    status: "completed" as const,
    agentId: "executor",
    role: "executor",
  };
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history);
  await domain.restore(scope.workflow.snapshot()!);
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, { ...history, runtimeSequence: 2, executorHistoryRef: "scout-artifact://workflow-001/executor/history/2.json" });
  await domain.restore(scope.workflow.snapshot()!);
  const deliveries: SendAgentMessageInput[] = [];
  scope.agentRegistry.registerAgent({
    agentId: "coordinator",
    role: "coordinator",
    async sendMessage(input: SendAgentMessageInput) {
      deliveries.push(input);
      return Result.ok(undefined);
    },
  } as unknown as ScoutAgent);
  await scope.eventBus.publishAndWait(RunEvents.runtime.ready, {
    mode: "resume", readyAt: new Date().toISOString(),
  });
  assert.deepEqual(deliveries.map((delivery) => delivery.delivery?.messageId), [
    `${scope.runId}-workflow-001-rbt-history-executor-1`,
    `${scope.runId}-workflow-001-rbt-history-executor-2`,
  ]);
});

test("RBT cancels restored history delivery on stop, completed restore, Workflow finish and commit", async (t) => {
  for (const boundary of ["stop", "completed_restore", "workflow_finish", "workflow_commit"] as const) {
    await t.test(boundary, async (context) => {
      const domain = new RbtDomain();
      const scope = await installTestRunScope(context, {
        runId: `run-rbt-history-cancel-${boundary}`,
        scoutRoot: process.cwd(),
        domain,
      });
      await domain.start();
      await domain.run();
      await scope.eventBus.publishAndWait(RbtEvents.history.ready, {
        bddId: "account", targetVersion: "1.0", platform: { type: "unity-editor", version: "test" },
        executeFileDigest: `sha256:${"a".repeat(64)}`, executorHistoryDigest: `sha256:${"b".repeat(64)}`,
        executorHistoryRef: "scout-artifact://workflow-001/executor/history/1.json",
        executeFileRef: "scout-artifact://workflow-001/executor/pack/execute-file.json",
        runtimeSequence: 1,
        campaignId: "campaign",
        scenarioId: "scenario",
        status: "completed",
        agentId: "executor",
        role: "executor",
      });
      await domain.restore(scope.workflow.snapshot()!);
      const deliveries: SendAgentMessageInput[] = [];
      scope.agentRegistry.registerAgent({
        agentId: "coordinator",
        role: "coordinator",
        async sendMessage(input: SendAgentMessageInput) {
          deliveries.push(input);
          return Result.ok(undefined);
        },
      } as unknown as ScoutAgent);
      if (boundary === "stop") {
        await domain.stop();
      } else if (boundary === "completed_restore") {
        await domain.close();
        await domain.restore({ ...scope.workflow.snapshot()!, status: "completed" });
      } else if (boundary === "workflow_finish") {
        await domain.close();
      } else {
        const prepareScout = scope.workflow.scoutRecordObject.prepare.bind(scope.workflow.scoutRecordObject);
        // This test isolates restored RBT delivery cancellation, not Agent baseline creation.
        t.mock.method(scope.workflow.scoutRecordObject, "prepare", (root: string) => prepareScout(root, []));
        const boundary = { workflowId: "workflow-002", journalRoot: join(scope.runRoot, "next-workflow") };
        await scope.eventBus.publishAndWait(WorkflowEvents.workflow.preparing, boundary);
        await scope.eventBus.publishAndWait(WorkflowEvents.workflow.committing, boundary);
        domain.create();
        await scope.eventBus.publishAndWait(WorkflowEvents.workflow.releasingPrevious, boundary);
      }
      await scope.eventBus.publishAndWait(RunEvents.runtime.ready, {
        mode: "resume", readyAt: new Date().toISOString(),
      });
      assert.deepEqual(deliveries, []);
    });
  }
});

test("RBT stops an in-flight history replay before delivering the next history", async (t) => {
  const domain = new RbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-history-stop-in-flight",
    scoutRoot: process.cwd(),
    domain,
  });
  await domain.start();
  await domain.run();
  for (const runtimeSequence of [1, 2]) {
    await scope.eventBus.publishAndWait(RbtEvents.history.ready, {
      bddId: "account", targetVersion: "1.0", platform: { type: "unity-editor", version: "test" },
      executeFileDigest: `sha256:${"a".repeat(64)}`, executorHistoryDigest: `sha256:${"b".repeat(64)}`,
      executorHistoryRef: `scout-artifact://workflow-001/executor/history/${runtimeSequence}.json`,
      executeFileRef: "scout-artifact://workflow-001/executor/pack/execute-file.json",
      runtimeSequence,
      campaignId: "campaign",
      scenarioId: "scenario",
      status: "completed",
      agentId: "executor",
      role: "executor",
    });
  }
  await domain.restore(scope.workflow.snapshot()!);
  let started!: () => void;
  const deliveryStarted = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const deliveryReleased = new Promise<void>((resolve) => { release = resolve; });
  const deliveries: SendAgentMessageInput[] = [];
  scope.agentRegistry.registerAgent({
    agentId: "coordinator",
    role: "coordinator",
    async sendMessage(input: SendAgentMessageInput) {
      deliveries.push(input);
      started();
      await deliveryReleased;
      return Result.ok(undefined);
    },
  } as unknown as ScoutAgent);
  const ready = scope.eventBus.publishAndWait(RunEvents.runtime.ready, {
    mode: "resume", readyAt: new Date().toISOString(),
  });
  await deliveryStarted;
  await domain.stop();
  release();
  await ready;
  assert.equal(deliveries.length, 1);
});

test("RBT restored history delivery failures reject runtime ready and can be retried on restore", async (t) => {
  const domain = new RbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-history-delivery-failure",
    scoutRoot: process.cwd(),
    domain,
  });
  await domain.start();
  await domain.run();
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, {
    bddId: "account", targetVersion: "1.0", platform: { type: "unity-editor", version: "test" },
    executeFileDigest: `sha256:${"a".repeat(64)}`, executorHistoryDigest: `sha256:${"b".repeat(64)}`,
    executorHistoryRef: "scout-artifact://workflow-001/executor/history/1.json",
    executeFileRef: "scout-artifact://workflow-001/executor/pack/execute-file.json",
    runtimeSequence: 1,
    campaignId: "campaign",
    scenarioId: "scenario",
    status: "completed",
    agentId: "executor",
    role: "executor",
  });
  await domain.restore(scope.workflow.snapshot()!);
  await assert.rejects(scope.eventBus.publishAndWait(RunEvents.runtime.ready, {
    mode: "resume", readyAt: new Date().toISOString(),
  }), /without the Coordinator agent/);

  let fail = true;
  const deliveries: SendAgentMessageInput[] = [];
  scope.agentRegistry.registerAgent({
    agentId: "coordinator",
    role: "coordinator",
    async sendMessage(input: SendAgentMessageInput) {
      deliveries.push(input);
      return fail ? Result.err("restored history enqueue failed") : Result.ok(undefined);
    },
  } as unknown as ScoutAgent);
  await domain.restore(scope.workflow.snapshot()!);
  await assert.rejects(scope.eventBus.publishAndWait(RunEvents.runtime.ready, {
    mode: "resume", readyAt: new Date().toISOString(),
  }), /restored history enqueue failed/);
  await domain.restore(scope.workflow.snapshot()!);
  fail = false;
  await scope.eventBus.publishAndWait(RunEvents.runtime.ready, {
    mode: "resume", readyAt: new Date().toISOString(),
  });
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries[0], deliveries[1]);
});

test("ScoutExecutionSystem routes caller-owned identities through one run Handler", async () => {
  const operations: string[] = [];
  const identity: ExecutionPlatformIdentity = {
    type: "unity_editor",
    version: "6000.0.80f1",
  };
  const selection = { transport: "unity-pipeline", platform: identity };
  const system = await ScoutExecutionSystem.start({
    async start() {
      operations.push("start");
    },
    async invoke(invocation) {
      const operation = invocation.operation;
      operations.push(operation);
      return operation === "identify"
        ? appPilotIdentityResponse(identity)
        : { ok: true };
    },
    async close() {
      operations.push("close");
    },
  });

  assert.deepEqual(await system.identify(), { ok: true, identity });
  assert.deepEqual(await system.launch({ identity: selection }), { ok: true, identity });
  assert.deepEqual(await system.launch({ identity: selection }), { ok: true, identity });
  assert.deepEqual(operations, ["start", "identify", "launch", "launch"]);

  assert.deepEqual(await system.shutdown({ identity: selection }), { ok: true, identity });
  assert.deepEqual(operations, [
    "start",
    "identify",
    "launch",
    "launch",
    "shutdown",
  ]);

  assert.deepEqual(await system.shutdown({ identity: selection }), { ok: true, identity });
  assert.deepEqual(operations.slice(-2), ["shutdown", "shutdown"]);
});

test("AppPilot Handler passes one explicit identity to each independent CLI process", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-apppilot-handler-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scriptPath = join(root, "fake-apppilot.mjs");
  const callsPath = join(root, "calls.jsonl");
  writeFileSync(scriptPath, [
    'import { appendFileSync } from "node:fs";',
    "const args = process.argv.slice(2);",
    `appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
    'const idIndex = args.indexOf("--id");',
    'process.stdout.write(JSON.stringify({ id: args[idIndex + 1], ok: true }) + "\\n");',
  ].join("\n"), "utf8");
  const handler = new AppPilotExecutionHandler({
    cwd: root,
    executable: process.execPath,
    baseArgs: [scriptPath],
  });
  const identity = {
    transport: "adb",
    platform: { type: "android", version: "17" },
  };

  await handler.start();
  assert.deepEqual(await handler.invoke({
    operation: "launch",
    identity,
    parameters: { appId: "com.example.app" },
  }), { ok: true });
  assert.deepEqual(await handler.invoke({
    operation: "shutdown",
    identity,
    parameters: { appId: "com.example.app" },
  }), { ok: true });
  await handler.close();

  const calls = readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((args) => args[0]), ["launch", "shutdown"]);
  for (const args of calls) {
    const identityIndex = args.indexOf("--identity");
    assert.deepEqual(JSON.parse(args[identityIndex + 1]), identity);
  }
});

test("Execution Commands validate Android parameters when the semantic is invoked", async () => {
  const calls: Array<{ operation: string; parameters: Readonly<Record<string, ExecutionHandlerValue>> }> = [];
  const identity: ExecutionPlatformIdentity = { type: "android", version: "16" };
  const selection = { transport: "adb", platform: identity };
  const system = await ScoutExecutionSystem.start({
    async start() {},
    async invoke(invocation) {
      calls.push(invocation);
      return invocation.operation === "identify"
        ? {
          ok: true,
          value: {
            transport: "adb",
            platform: { type: identity.type, version: identity.version },
          },
        }
        : { ok: true };
    },
    async close() {},
  });

  assert.deepEqual(await system.launch({ identity: selection }), {
    ok: false,
    code: "execution_launch_invalid_input",
    message: "Android launch requires appId.",
  });
  assert.deepEqual(await system.identify({ transport: "adb", platform: "android" }), {
    ok: true,
    identity,
  });
  assert.deepEqual(await system.launch({ identity: selection }), {
    ok: false,
    code: "execution_launch_invalid_input",
    message: "Android launch requires appId.",
  });
  assert.deepEqual(await system.launch({
    identity: selection,
    appId: "com.example.app",
    parameters: {
      guru_debug: "true",
      guru_ws_client_ip_port: "127.0.0.1:18083",
    },
  }), { ok: true, identity });
  assert.deepEqual(calls, [
    { operation: "identify", parameters: { transport: "adb" } },
    {
      operation: "launch",
      identity: selection,
      parameters: {
        appId: "com.example.app",
        launchParameters: {
          guru_debug: "true",
          guru_ws_client_ip_port: "127.0.0.1:18083",
        },
      },
    },
  ]);
  await system.dispose();
});

test("ScoutExecutionSystem serializes lifecycle operations and closes before disposal", async () => {
  const operations: string[] = [];
  const identity: ExecutionPlatformIdentity = {
    type: "unity_editor",
    version: "6000.0.80f1",
  };
  const selection = { transport: "unity-pipeline", platform: identity };
  let activeOperations = 0;
  let maximumActiveOperations = 0;
  const system = await ScoutExecutionSystem.start({
    async start() {
      operations.push("start");
    },
    async invoke(invocation) {
      activeOperations += 1;
      maximumActiveOperations = Math.max(maximumActiveOperations, activeOperations);
      const operation = invocation.operation;
      operations.push(operation);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeOperations -= 1;
      return operation === "identify"
        ? appPilotIdentityResponse(identity)
        : { ok: true };
    },
    async close() {
      operations.push("close");
    },
  });

  assert.deepEqual(await system.identify(), { ok: true, identity });
  const firstLaunch = system.launch({ identity: selection });
  const secondLaunch = system.launch({ identity: selection });
  const disposal = system.dispose();

  assert.deepEqual(await system.launch({ identity: selection }), {
    ok: false,
    code: "execution_system_disposed",
    message: "The Scout execution system has been disposed.",
  });
  assert.deepEqual(await firstLaunch, { ok: true, identity });
  assert.deepEqual(await secondLaunch, { ok: true, identity });
  await disposal;

  assert.deepEqual(operations, [
    "start",
    "identify",
    "launch",
    "launch",
    "close",
  ]);
  assert.equal(maximumActiveOperations, 1);
});

test("ExecutionPlatform Agent tool accepts only operation semantics and uses runtime configuration", async (t) => {
  const identity: ExecutionPlatformIdentity = { type: "android", version: "34" };
  const requests: Array<{ operation: string; request: ExecutionPlatformRequest }> = [];
  const eventBus = new InMemoryEventBus();
  await installTestRunScope(t, {
    runId: "run-execution-platform-tool",
    eventBus,
    executionSystem: fakeExecutionSystem({
      identity,
      onIdentify: (request) => requests.push({ operation: "identify", request: request ?? {} }),
      onLaunch: (request) => requests.push({ operation: "launch", request: request ?? {} }),
      onShutdown: (request) => requests.push({ operation: "shutdown", request: request ?? {} }),
    }),
  });
  const tool = new ExecutionPlatformTool(baseDomain(currentRunScope()).execution);
  baseDomain(currentRunScope()).execution.configure({
    transport: "adb",
    platform: "android",
    appId: "com.example.first",
    parameters: { activity: "MainActivity" },
  });

  const launched = await tool.execute(dynamicCall({
    callId: "call-execution-platform-launch",
    namespace: "domain_execution",
    tool: "ExecutionPlatform",
    arguments: {
      operation: "launch",
    },
    role: "executor",
  }) as ScoutDomainDynamicToolCall);
  assert.equal(launched.success, true);
  assert.deepEqual(JSON.parse(launched.contentItems[0]?.text ?? "null"), {
    operation: "launch",
    status: "completed",
    identity,
  });

  const mismatched = await tool.execute(dynamicCall({
    callId: "call-execution-platform-shutdown-mismatched-app",
    namespace: "domain_execution",
    tool: "ExecutionPlatform",
    arguments: {
      operation: "shutdown",
      request: {
        transport: "adb",
        platform: "android",
        appId: "com.example.second",
      },
    },
    role: "executor",
  }) as ScoutDomainDynamicToolCall);
  assert.equal(mismatched.success, false);
  assert.equal(JSON.parse(mismatched.contentItems[0]?.text ?? "null").code, "execution_platform_invalid_input");
  assert.deepEqual(requests.map((entry) => entry.operation), ["identify", "launch"]);

  const stopped = await tool.execute(dynamicCall({
    callId: "call-execution-platform-shutdown",
    namespace: "domain_execution",
    tool: "ExecutionPlatform",
    arguments: {
      operation: "shutdown",
    },
    role: "executor",
  }) as ScoutDomainDynamicToolCall);
  assert.equal(stopped.success, true);
  assert.deepEqual(requests, [
    {
      operation: "identify",
      request: { transport: "adb", platform: "android" },
    },
    {
      operation: "launch",
      request: {
        identity: { transport: "adb", platform: identity },
        appId: "com.example.first",
        parameters: { activity: "MainActivity" },
      },
    },
    {
      operation: "shutdown",
      request: {
        identity: { transport: "adb", platform: identity },
        appId: "com.example.first",
      },
    },
  ]);
});

test("RBT hides ExecutionPlatform from Executor", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = new RbtDomain();
  const asset = buildWorkflow(process.cwd(), "rbt");
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-unity-pipeline",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: new Graph(asset),
    workflowAsset: asset,
  });
  const roots = roleRoots(scope.runRoot, "executor");
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: {
      ...roots,
      readableRoots: [],
      shellTools: [],
    },
  }));
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const call = dynamicCall({
    callId: "call-execution-platform",
    namespace: "domain_execution",
    tool: "ExecutionPlatform",
    arguments: { operation: "launch" },
    role: "executor",
  });

  const caller = { agentId: "executor", role: "executor", phases: ["execute"], threadId: call.input.threadId } as ScoutAgent;
  t.mock.method(scope.agentRegistry, "resolveToolCaller", () => caller);
  const execution = t.mock.method(baseDomain(scope).backend, "handleDynamicToolCall");
  const denied = await new AgentDynamicToolBackend().handleDynamicToolCall(call.input);
  assert.ok(denied);
  assert.equal(denied.success, false);
  assert.match(denied.contentItems[0]?.text ?? "", /ExecutionPlatform is not configured for Phase execute/);
  assert.equal(execution.mock.callCount(), 0);
});

test("RBT Reviewer shuts down the restored session using only operation, even when configuration differs", async (t) => {
  const eventBus = new InMemoryEventBus();
  const identity: ExecutionPlatformIdentity = { type: "android", version: "34" };
  const requests: Array<{ operation: string; request: ExecutionPlatformRequest }> = [];
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-review-shutdown-"));
  const configRoot = join(root, "assets", "scout", "config");
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(configRoot, "rbt.config.json"), JSON.stringify({
    execution: {
      transport: "adb",
      platform: "android",
      appId: "com.example.next",
    },
  }), "utf8");
  const domain = new RbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-review-shutdown",
    scoutRoot: root,
    runRoot: join(root, "run"),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem({
      identity,
      onIdentify: (request) => requests.push({ operation: "identify", request: request ?? {} }),
      onLaunch: (request) => requests.push({ operation: "launch", request: request ?? {} }),
      onShutdown: (request) => requests.push({ operation: "shutdown", request: request ?? {} }),
    }),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseCalls: string[] = [];
  const specializedCalls: string[] = [];
  eventBus.subscribe(BaseDomainEvents.agentToolCall.observed, (event) => {
    if (BaseDomainEvents.agentToolCall.observed.is(event)) baseCalls.push(event.payload.callId);
  });
  eventBus.subscribe(DomainEvents.agentToolCall.observed, (event) => {
    if (DomainEvents.agentToolCall.observed.is(event)) specializedCalls.push(event.payload.callId);
  });
  baseDomain(scope).start();
  baseDomain(scope).recordObject.write(eventBus.publish(
    ExecutionEvents.execution.launchCompleted,
    {
      correlationId: "restored-launch",
      request: {
        identity: { transport: "adb", platform: identity },
        appId: "com.example.app",
      },
      result: {
        ok: true,
        selection: { transport: "adb", platform: identity },
      },
    },
    { occurredAt: "2026-09-24T00:00:00.000Z" },
  ));
  await domain.start();
  baseDomain(scope).restore(scope.workflow.snapshot()!);
  await domain.restore(scope.workflow.snapshot()!);
  await domain.run();
  await domain.run();
  t.after(async () => {
    await domain.stop();
    baseDomain(scope).close();
  });

  const response = await baseDomain(scope).backend.handleDynamicToolCall(dynamicCall({
    callId: "call-review-shutdown",
    namespace: "domain_execution",
    tool: "ExecutionPlatform",
    arguments: {
      operation: "shutdown",
    },
    role: "reviewer",
  }));
  assert.ok(response);

  assert.equal(response.success, true);
  assert.deepEqual(JSON.parse(response.contentItems[0]?.text ?? "null"), {
    operation: "shutdown",
    status: "completed",
    identity,
  });
  assert.deepEqual(requests, [
    {
      operation: "shutdown",
      request: {
        identity: {
          transport: "adb",
          platform: identity,
        },
        appId: "com.example.app",
      },
    },
  ]);
  assert.deepEqual(baseCalls, ["call-review-shutdown"]);
  assert.deepEqual(specializedCalls, []);
  assert.equal(baseDomain(scope).toolCallStore.list()[0]?.callId, "call-review-shutdown");
});

test("JarvisBehavior prepares Play Mode without an Agent UnityPipeline call", async (t) => {
  const eventBus = new InMemoryEventBus();
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-platform-gate-test-"));
  const markerPath = join(root, "unity-operations.log");
  const domain = rbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-platform-gate",
    runRoot: join(root, "run"),
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem({
      onLaunch: () => {
        writeFileSync(markerPath, [
          "status",
          "editor_status",
          "editor_play",
          "editor_status",
          "editor_status",
        ].join("\n") + "\n");
      },
    }),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const response = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-variants-with-platform-gate",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.node.variants",
      payload: { id: "account.account_auth.restore" },
    },
    role: "executor",
  }));

  assert.equal(response?.success, true);
  assert.deepEqual(readFileSync(markerPath, "utf8").trim().split("\n"), [
    "status",
    "editor_status",
    "editor_play",
    "editor_status",
    "editor_status",
  ]);
});

test("JarvisBehavior reports Play Mode readiness timeout before WebSocket connection", async (t) => {
  const eventBus = new InMemoryEventBus();
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-platform-timeout-test-"));
  const markerPath = join(root, "unity-operations.log");
  const domain = rbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-platform-timeout",
    runRoot: join(root, "run"),
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem({
      onLaunch: () => {
        writeFileSync(markerPath, ["status", "editor_status", "editor_play"].join("\n") + "\n");
      },
      launchFailure: {
        code: "unity_play_mode_start_timeout",
        message: "The Unity Editor did not become ready in Play Mode before the platform timeout.",
      },
    }),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const response = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-variants-with-platform-timeout",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.node.variants",
      payload: { id: "account.account_auth.restore" },
    },
    role: "executor",
  }));

  assert.equal(response?.success, false);
  assert.deepEqual(JSON.parse(response?.contentItems[0]?.text ?? "null"), {
    status: "failed",
    error: {
      code: "unity_play_mode_start_timeout",
      message: "The Unity Editor did not become ready in Play Mode before the platform timeout.",
    },
  });
  const operations = readFileSync(markerPath, "utf8").trim().split("\n");
  assert.deepEqual(operations.slice(0, 3), ["status", "editor_status", "editor_play"]);
  assert.equal(operations.filter((operation) => operation === "editor_play").length, 1);
});

test("RBT Domain derives Android launch parameters from the identified target", async (t) => {
  const eventBus = new InMemoryEventBus();
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-android-launch-test-"));
  const configRoot = join(root, "assets", "scout", "config");
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(configRoot, "rbt.config.json"), JSON.stringify({
    execution: {
      transport: "adb",
      platform: "android",
      appId: "com.example.app",
    },
  }), "utf8");

  const requests: ExecutionPlatformRequest[] = [];
  let domain!: RbtDomain;
  domain = new RbtDomain({
    executionRequest: () => {
      const { transport, platform, appId } = domain.config.execution;
      return {
        ...(transport ? { transport } : {}),
        ...(platform ? { platform } : {}),
        ...(appId ? { appId } : {}),
      };
    },
    websocket: new JarvisWebSocketTool(undefined, (linkInput) => ({
      identity: linkInput.identity,
      async prepare() {
        return {
          ok: true,
          launchParameters: {
            guru_debug: "true",
            guru_ws_client_ip_port: "127.0.0.1:18083",
          },
          hostCommands: [],
        };
      },
      async connect() {
        return {
          ok: true,
          endpoint: "ws://127.0.0.1:8083",
          hostCommands: [],
        };
      },
      async close() {},
    })),
  });
  await installTestRunScope(t, {
    runId: "run-rbt-android-launch",
    scoutRoot: root,
    runRoot: join(root, "run"),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem({
      identity: { type: "android", version: "16" },
      onLaunch: (request) => requests.push(request ?? {}),
      launchFailure: {
        code: "expected_test_stop",
        message: "Stop after observing the launch request.",
      },
    }),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-android-launch-request",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.registry.nodes",
      payload: { domain: "Growth", category: "RemoteConfig" },
    },
    role: "executor",
  }));

  assert.deepEqual(requests, [{
    identity: {
      transport: "adb",
      platform: { type: "android", version: "16" },
    },
    appId: "com.example.app",
    parameters: {
      guru_debug: "true",
      guru_ws_client_ip_port: "127.0.0.1:18083",
    },
  }]);
});

test("RBT Execute and Review share one launched target across Phase tools", async (t) => {
  const eventBus = new InMemoryEventBus();
  const launches: ExecutionPlatformRequest[] = [];
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-shared-runtime-"));
  const websocket = new JarvisWebSocketTool(undefined, (input) => ({
    identity: input.identity,
    async prepare() {
      return { ok: true, launchParameters: {}, hostCommands: [] };
    },
    async connect() {
      return { ok: true, endpoint: "ws://127.0.0.1:8083", hostCommands: [] };
    },
    async close() {},
  }));
  const domain = rbtDomain({
    websocket,
    executionRequest: () => ({
      transport: "adb",
      platform: "android",
      appId: "com.example.app",
    }),
  });
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-shared-runtime",
    runRoot: join(root, "run"),
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem({
      identity: { type: "android", version: "17" },
      onLaunch: (launchRequest) => launches.push(launchRequest ?? {}),
    }),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const executeResult = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-phase-refresh-execute",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.registry.nodes",
      payload: { domain: "Growth", category: "RemoteConfig" },
    },
    role: "executor",
  }));
  const reviewResult = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-phase-refresh-review",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.campaign.query",
      payload: { campaignId: "campaign", scenarioId: "scenario", includeEvidence: true },
    },
    role: "reviewer",
  }));

  assert.equal(executeResult?.success, true);
  assert.equal(reviewResult?.success, true);
  assert.equal(launches.length, 1);
});

test("RBT Android Review reconnects a restored launched target without identify or launch", async (t) => {
  const eventBus = new InMemoryEventBus();
  const operations: string[] = [];
  const links: string[] = [];
  const identity: ExecutionPlatformIdentity = { type: "android", version: "17" };
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-restored-runtime-"));
  const websocket = new JarvisWebSocketTool(undefined, (input) => ({
    identity: input.identity,
    async prepare() {
      links.push("prepare");
      return { ok: true, launchParameters: {}, hostCommands: [] };
    },
    async connect() {
      links.push("connect");
      return { ok: true, endpoint: "ws://127.0.0.1:8083", hostCommands: [] };
    },
    async close() { links.push("close"); },
  }));
  const domain = rbtDomain({
    websocket,
    executionRequest: () => ({
      transport: "adb",
      platform: "android",
      appId: "com.example.app",
    }),
  });
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-restored-runtime",
    runRoot: join(root, "run"),
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem({
      identity,
      onIdentify: () => operations.push("identify"),
      onLaunch: () => operations.push("launch"),
      onShutdown: () => operations.push("shutdown"),
    }),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  baseDomain(scope).start();
  baseDomain(scope).recordObject.write(eventBus.publish(
    ExecutionEvents.execution.launchCompleted,
    {
      correlationId: "restored-launch",
      request: {
        identity: { transport: "adb", platform: identity },
        appId: "com.example.app",
      },
      result: {
        ok: true,
        selection: { transport: "adb", platform: identity },
      },
    },
    { occurredAt: "2026-09-24T00:00:00.000Z" },
  ));
  await domain.start();
  baseDomain(scope).restore(scope.workflow.snapshot()!);
  await domain.restore(scope.workflow.snapshot()!);
  await domain.run();
  t.after(async () => {
    await domain.stop();
    baseDomain(scope).close();
  });

  const result = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-restored-review",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.campaign.query",
      payload: { campaignId: "campaign", scenarioId: "scenario", includeEvidence: true },
    },
    role: "reviewer",
  }));

  assert.equal(result?.success, true, JSON.stringify(result));
  assert.deepEqual(operations, []);
  assert.deepEqual(links, ["prepare", "connect"]);
  await domain.restore(scope.workflow.snapshot()!);
  await domain.run();
  const reconnected = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-restored-review-again", namespace: "rbt_behavior", tool: "JarvisBehavior",
    arguments: { command: "behavior.campaign.query", payload: { campaignId: "campaign", scenarioId: "scenario", includeEvidence: true } },
    role: "reviewer",
  }));
  assert.equal(reconnected?.success, true);
  assert.deepEqual(operations, [], "restoring the transport must not identify, launch, or shut down the shared target");
  assert.deepEqual(links, ["prepare", "connect", "close", "prepare", "connect"]);
});

test("RBT Review does not identify or launch a missing Domain target", async (t) => {
  const eventBus = new InMemoryEventBus();
  const operations: string[] = [];
  const domain = rbtDomain({
    executionRequest: () => ({
      transport: "adb",
      platform: "android",
      appId: "com.example.app",
    }),
  });
  await installTestRunScope(t, {
    runId: "run-rbt-review-without-target",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem({
      identity: { type: "android", version: "17" },
      onIdentify: () => operations.push("identify"),
      onLaunch: () => operations.push("launch"),
      onShutdown: () => operations.push("shutdown"),
    }),
  });
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const result = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-review-without-target",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.campaign.query",
      payload: { campaignId: "campaign", scenarioId: "scenario", includeEvidence: true },
    },
    role: "reviewer",
  }));

  assert.equal(result?.success, false);
  assert.deepEqual(JSON.parse(result?.contentItems[0]?.text ?? "null"), {
    status: "failed",
    error: {
      code: "execution_target_unavailable",
      message: "The Base Domain execution target has not been identified.",
    },
  });
  assert.deepEqual(operations, []);
});

test("RBT Review link failure does not stop the shared Domain target", async (t) => {
  const eventBus = new InMemoryEventBus();
  const operations: string[] = [];
  const identity: ExecutionPlatformIdentity = { type: "android", version: "17" };
  const domain = rbtDomain({
    executionRequest: () => ({
      transport: "adb",
      platform: "android",
      appId: "com.example.app",
    }),
    websocket: new JarvisWebSocketTool(undefined, (input) => ({
      identity: input.identity,
      async prepare() {
        return { ok: true, launchParameters: {}, hostCommands: [] };
      },
      async connect() {
        return {
          ok: false,
          code: "websocket_connect_failed",
          message: "Runtime endpoint unavailable.",
          hostCommands: [],
        };
      },
      async close() {},
    })),
  });
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-review-link-failure",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem({
      identity,
      onIdentify: () => operations.push("identify"),
      onLaunch: () => operations.push("launch"),
      onShutdown: () => operations.push("shutdown"),
    }),
  });
  baseDomain(scope).start();
  baseDomain(scope).recordObject.write(eventBus.publish(
    ExecutionEvents.execution.launchCompleted,
    {
      correlationId: "restored-launch-for-review-failure",
      request: {
        identity: { transport: "adb", platform: identity },
        appId: "com.example.app",
      },
      result: {
        ok: true,
        selection: { transport: "adb", platform: identity },
      },
    },
    { occurredAt: "2026-09-24T00:00:00.000Z" },
  ));
  await domain.start();
  await domain.run();
  baseDomain(scope).restore(scope.workflow.snapshot()!);
  await domain.restore(scope.workflow.snapshot()!);
  t.after(async () => {
    await domain.stop();
    baseDomain(scope).close();
  });

  const result = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-review-link-failure",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.campaign.query",
      payload: { campaignId: "campaign", scenarioId: "scenario", includeEvidence: true },
    },
    role: "reviewer",
  }));

  assert.equal(result?.success, false);
  assert.deepEqual(operations, []);
});

test("RBT Domain stops a target after link failure so the next attempt relaunches it", async (t) => {
  const eventBus = new InMemoryEventBus();
  const lifecycle: string[] = [];
  const domain = new RbtDomain({
    executionRequest: () => ({
      transport: "adb",
      platform: "android",
      appId: "com.example.app",
    }),
    websocket: new JarvisWebSocketTool(undefined, (linkInput) => ({
      identity: linkInput.identity,
      async prepare() {
        return {
          ok: true,
          launchParameters: {
            guru_debug: "true",
            guru_ws_client_ip_port: "127.0.0.1:18083",
          },
          hostCommands: [],
        };
      },
      async connect() {
        return {
          ok: false,
          code: "websocket_connect_failed",
          message: "Runtime endpoint unavailable.",
          hostCommands: [],
        };
      },
      async close() {},
    })),
  });
  await installTestRunScope(t, {
    runId: "run-rbt-link-retry",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem({
      identity: { type: "android", version: "16" },
      onLaunch: () => lifecycle.push("launch"),
      onShutdown: () => lifecycle.push("shutdown"),
    }),
  });
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const call = dynamicCall({
    callId: "call-link-retry",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.registry.nodes",
      payload: { domain: "Growth", category: "RemoteConfig" },
    },
    role: "executor",
  });
  const first = await domain.backend.handleDynamicToolCall(call);
  const second = await domain.backend.handleDynamicToolCall({
    ...call,
    input: { ...call.input, callId: "call-link-retry-second" },
  });

  assert.equal(first?.success, false);
  assert.equal(second?.success, false);
  assert.deepEqual(lifecycle, ["launch", "shutdown", "launch", "shutdown"]);
});

test("RBT Execute link failure does not shut down an already running shared target", async (t) => {
  const eventBus = new InMemoryEventBus();
  const lifecycle: string[] = [];
  const request = { transport: "adb", platform: "android", appId: "com.example.app" };
  const domain = new RbtDomain({
    executionRequest: () => request,
    websocket: new JarvisWebSocketTool(undefined, (input) => ({
      identity: input.identity,
      async prepare() { return { ok: true, launchParameters: {}, hostCommands: [] }; },
      async connect() {
        return { ok: false, code: "link_failed", message: "RBT link failed.", hostCommands: [] };
      },
      async close() {},
    })),
  });
  const scope = await installTestRunScope(t, {
    runId: "rbt-shared-target-link-failure",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem({
      identity: { type: "android", version: "34" },
      onLaunch: () => lifecycle.push("launch"),
      onShutdown: () => lifecycle.push("shutdown"),
    }),
  });
  await domain.start();
  await domain.run();
  const execution = baseDomain(scope).execution;
  const target = await execution.resolve(request);
  assert.ok(target.ok);
  await execution.ensureStarted(request, target.identity);
  const result = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-shared-target-link-failure",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { command: "behavior.registry.nodes", payload: {} },
    role: "executor",
  }));
  assert.ok(result);
  assert.equal(result.success, false);
  assert.deepEqual(lifecycle, ["launch"]);
  const current = execution.current(request);
  assert.ok(current.ok && current.started);
});

test("RBT Execute link failure preserves a fresh target reused by another caller during connect", async (t) => {
  const eventBus = new InMemoryEventBus();
  const lifecycle: string[] = [];
  const request = { transport: "adb", platform: "android", appId: "com.example.app" };
  const domain = new RbtDomain({
    executionRequest: () => request,
    websocket: new JarvisWebSocketTool(undefined, (input) => ({
      identity: input.identity,
      async prepare() { return { ok: true, launchParameters: {}, hostCommands: [] }; },
      async connect() {
        const execution = baseDomain(currentRunScope()).execution;
        const target = await execution.resolve(request);
        assert.ok(target.ok && target.started);
        const reused = await execution.ensureStarted(request, target.identity);
        assert.ok(reused.ok && !reused.launched);
        return { ok: false, code: "link_failed", message: "RBT link failed after target reuse.", hostCommands: [] };
      },
      async close() {},
    })),
  });
  const scope = await installTestRunScope(t, {
    runId: "rbt-target-reused-during-connect",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem({
      identity: { type: "android", version: "34" },
      onLaunch: () => lifecycle.push("launch"),
      onShutdown: () => lifecycle.push("shutdown"),
    }),
  });
  await domain.start();
  await domain.run();
  const result = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-target-reused-during-connect",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { command: "behavior.registry.nodes", payload: {} },
    role: "executor",
  }));
  assert.ok(result);
  assert.equal(result.success, false);
  assert.deepEqual(lifecycle, ["launch"]);
  const current = baseDomain(scope).execution.current(request);
  assert.ok(current.ok && current.started);
});

test("Jarvis WebSocket waits for a Runtime endpoint that is starting", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-websocket-startup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const connectedPath = join(root, "connected");
  const attemptsPath = join(root, "attempts");
  const script = [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(1);",
    `const connectedPath = ${JSON.stringify(connectedPath)};`,
    `const attemptsPath = ${JSON.stringify(attemptsPath)};`,
    "if (args.includes('status')) {",
    "  process.stdout.write(fs.existsSync(connectedPath)",
    "    ? 'WS session test: connected url=ws://127.0.0.1:8083\\n'",
    "    : 'WS session test: disconnected\\n');",
    "} else if (args.includes('connect')) {",
    "  const attempts = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, 'utf8')) : 0;",
    "  fs.writeFileSync(attemptsPath, String(attempts + 1));",
    "  if (attempts === 0) {",
    "    process.stderr.write('[ERROR] connect ECONNREFUSED 127.0.0.1:8083\\n');",
    "    process.exitCode = 1;",
    "  } else {",
    "    fs.writeFileSync(connectedPath, 'connected\\n');",
    "    process.stdout.write('connected\\n');",
    "  }",
    "}",
  ].join("\n");
  const websocket = new JarvisWebSocketTool();

  const result = await websocket.ensureSession({
    agentId: "executor",
    sessionId: "test",
    endpoint: "ws://127.0.0.1:8083",
    executable: process.execPath,
    baseArgs: ["-e", script, "--"],
    cwd: root,
    timeoutMs: 2_000,
  });

  assert.equal(result.status, "connected");
  assert.equal(readFileSync(attemptsPath, "utf8"), "2");
  assert.equal(result.hostCommands.filter((command) => command.args.includes("connect")).length, 2);
});

test("JarvisBehavior reports an unavailable human-prepared Unity Editor", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-platform-unavailable",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem({
      launchFailure: {
        code: "transport_unavailable",
        message: "Transport unity-pipeline has no available platform.",
      },
    }),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const response = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-variants-without-editor",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.node.variants",
      payload: { id: "account.account_auth.restore" },
    },
    role: "executor",
  }));

  assert.equal(response?.success, false);
  assert.deepEqual(JSON.parse(response?.contentItems[0]?.text ?? "null"), {
    status: "failed",
    error: {
      code: "transport_unavailable",
      message: "Transport unity-pipeline has no available platform.",
    },
  });
});

test("JarvisBehavior blocks RBT while the Unity Editor is compiling", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-platform-compiling",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem({
      launchFailure: {
        code: "unity_editor_compiling",
        message: "The Unity Editor is compiling; execution must stop until it is stable.",
      },
    }),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const response = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-variants-while-compiling",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.node.variants",
      payload: { id: "account.account_auth.restore" },
    },
    role: "executor",
  }));

  assert.equal(response?.success, false);
  assert.deepEqual(JSON.parse(response?.contentItems[0]?.text ?? "null"), {
    status: "failed",
    error: {
      code: "unity_editor_compiling",
      message: "The Unity Editor is compiling; execution must stop until it is stable.",
    },
  });
});

test("JarvisBehavior blocks RBT during Unity domain reload and version changes", async (t) => {
  const cases = [
    {
      runId: "run-rbt-platform-domain-reload",
      code: "unity_editor_domain_reload",
      message: "The Unity Editor domain reload is in progress; execution must stop until it is stable.",
    },
    {
      runId: "run-rbt-platform-version-changed",
      code: "execution_platform_changed",
      message: "The identified execution platform changed during its lifecycle operation.",
    },
  ] as const;

  for (const item of cases) {
    await t.test(item.runId, async (testContext) => {
      const eventBus = new InMemoryEventBus();
      const domain = rbtDomain();
      const scope = await installTestRunScope(testContext, {
        runId: item.runId,
        scoutRoot: process.cwd(),
        eventBus,
        domain,
        runtimeGraph: rbtGraph(eventBus),
        executionSystem: fakeExecutionSystem({
          launchFailure: { code: item.code, message: item.message },
        }),
      });
      const roots = roleRoots(scope.runRoot, "executor");
      const codebaseRoot = installBehaviorSchema(scope.runRoot);
      scope.setEnvironment(rbtEnvironment(scope.runId, {
        executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
      }));
      await domain.start();
      await domain.run();
      testContext.after(() => domain.stop());

      const response = await domain.backend.handleDynamicToolCall(dynamicCall({
        callId: `${item.runId}-call`,
        namespace: "rbt_behavior",
        tool: "JarvisBehavior",
        arguments: {
          command: "behavior.node.variants",
          payload: { id: "account.account_auth.restore" },
        },
        role: "executor",
      }));

      assert.equal(response?.success, false);
      assert.deepEqual(JSON.parse(response?.contentItems[0]?.text ?? "null"), {
        status: "failed",
        error: { code: item.code, message: item.message },
      });
    });
  }
});

test("JarvisBehavior blocks an unavailable Unity Editor state", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-platform-starting",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem({
      launchFailure: {
        code: "unity_editor_unavailable",
        message: "The connected Unity Editor is not ready for execution.",
      },
    }),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const response = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-variants-while-starting",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.node.variants",
      payload: { id: "account.account_auth.restore" },
    },
    role: "executor",
  }));

  assert.equal(response?.success, false);
  assert.deepEqual(JSON.parse(response?.contentItems[0]?.text ?? "null"), {
    status: "failed",
    error: {
      code: "unity_editor_unavailable",
      message: "The connected Unity Editor is not ready for execution.",
    },
  });
});

test("RBT Agent tool-call recorder consumes the shared Domain event", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = new RbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-shared-tool-event",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [], shellTools: [] },
  }));
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  await eventBus.publishAndWait(DomainEvents.agentToolCall.observed, {
    domainId: "rbt",
    callId: "call-behavior-nodes",
    threadId: "thread-executor",
    agentId: "executor",
    role: "executor",
    phase: "execute",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { command: "behavior.registry.nodes", payload: { domain: "Account" } },
    response: {
      success: true,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify({ status: "completed", command: "behavior.registry.nodes", result: { nodes: [] } }),
      }],
    },
    startedAt: "2026-09-10T00:00:00.000Z",
    completedAt: "2026-09-10T00:00:01.000Z",
  });

  const log = readFileSync(join(roots.logsRoot, "rbt-agent-tool-call.log"), "utf8");
  assert.match(log, /domain\.shared\.agent_tool_call\.observed/);
  assert.match(log, /call-behavior-nodes/);
  assert.match(log, /status: "completed"/);
  assert.doesNotMatch(log, /contentItems/);
});

for (const inputOwner of ["current", "historical"] as const) {
test(`RBT executes a ${inputOwner} Pack input through the same pipeline and records current campaign history`, async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-history",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem(),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: {
      ...roots,
      readableRoots: [codebaseRoot],
      shellTools: [],
    },
  }));
  const coordinatorMessages: string[] = [];
  scope.agentRegistry.registerAgent({
    agentId: "coordinator",
    role: "coordinator",
    async sendMessage(input: { message: string }) {
      coordinatorMessages.push(input.message);
      return Result.ok(undefined);
    },
  } as unknown as ScoutAgent);
  const campaignEvents: string[] = [];
  eventBus.subscribe(RbtEvents.campaign, (event) => {
    campaignEvents.push(event.key.routeKey);
  });
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const sourceRoot = inputOwner === "current" ? roots.artifactRoot
    : workflowAgentPaths(join(scope.runRoot, "workflows", "imported Pack"), "old-executor").artifactRoot;
  const { executeFilePath } = writeTestExecuteFile(sourceRoot);
  if (inputOwner === "historical") {
    writeFileSync(workflowPaths(join(scope.runRoot, "workflows", "imported Pack")).identityPath,
      JSON.stringify({ workflowId: "workflow-009" }));
  }
  const originalInput = readFileSync(executeFilePath, "utf8");
  const executeFileRef = `scout-artifact://${inputOwner === "current" ? "workflow-001/executor" : "workflow-009/old-executor"}/pack/execute-file.json`;
  const executeInput = { workflowId: inputOwner === "current" ? "workflow-001" : "workflow-009", agentId: inputOwner === "current" ? "executor" : "old-executor", internalSymbols: ["pack", "execute-file.json"] };
  const execution = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-execute-file",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { execute_file: executeInput },
    role: "executor",
  }));

  assert.equal(execution?.success, true);
  const executionOutput = JSON.parse(execution?.contentItems[0]?.text ?? "null") as {
    status: string;
    operation: string;
    executedCommands: number;
  };
  assert.deepEqual(executionOutput, {
    status: "completed",
    operation: "execute_file",
    executedCommands: 5,
  });
  assert.deepEqual(campaignEvents, [
    "domain.rbt.campaign.start",
    "domain.rbt.campaign.command",
    "domain.rbt.campaign.command",
    "domain.rbt.campaign.command",
    "domain.rbt.campaign.end",
  ]);

  const historyRoot = join(roots.artifactRoot, "history");
  assert.deepEqual(readdirSync(historyRoot), ["001.json"]);
  const history = JSON.parse(readFileSync(join(historyRoot, "001.json"), "utf8")) as {
    runtimeSequence: number;
    executeFileRef: string;
    campaignId: string;
    scenarioId: string;
    platform: { type: string; version: string };
    status: string;
    commands: Array<{
      input: { command: string; payload: Record<string, unknown> };
      request: { correlationId: string };
      hostCommands: Array<{ executable: string; args: string[]; result: { stdout: string } }>;
    }>;
  };
  assert.deepEqual(history.executeFileRef, executeInput);
  assert.equal(history.runtimeSequence, 1);
  assert.equal(history.campaignId, "account.restore.success/campaign/main");
  assert.equal(history.scenarioId, "account.restore.success");
  assert.deepEqual(history.platform, {
    type: "unity_editor",
    version: "6000.0.80f1",
  });
  assert.equal(history.status, "completed");
  const recorded = [...new RbtDomainProjector().project(domain.recordObject.read()).artifacts.histories.values()].at(-1)!.history;
  assert.equal(recorded.bddId, "account-anon-restore-existing-account");
  assert.equal(recorded.targetVersion, "26.7.0-rc.2");
  assert.deepEqual(recorded.platform, history.platform);
  assert.equal(recorded.executeFileDigest, `sha256:${createHash("sha256").update(readFileSync(executeFilePath)).digest("hex")}`);
  assert.equal(recorded.executorHistoryDigest, `sha256:${createHash("sha256").update(readFileSync(join(historyRoot, "001.json"))).digest("hex")}`);
  const benchmark = scope.workflow.benchmarks.read("rbt", ["bddCatalog", recorded.bddId, recorded.targetVersion, "history", "lastExecutionSuccess"]);
  assert.ok(benchmark && typeof benchmark === "object" && !Array.isArray(benchmark));
  assert.equal(benchmark.workflowId, "workflow-001");
  assert.equal("artifactType" in history, false);
  assert.equal("artifactVersion" in history, false);
  assert.equal("runId" in history, false);
  assert.equal("agentId" in history, false);
  assert.equal("role" in history, false);
  assert.equal("artifactRef" in history, false);
  assert.equal(history.commands.length, 5);
  assert.equal(history.commands[0]?.input.command, "behavior.campaign.start");
  assert.equal(history.commands[4]?.input.command, "behavior.campaign.stop");
  assert.match(history.commands[0]?.request.correlationId ?? "", /^run-rbt-history\/cmd\/002-/);
  assert.equal("correlationId" in (history.commands[0]?.input ?? {}), false);
  assert.ok((history.commands[0]?.hostCommands.length ?? 0) >= 1);
  assert.equal(history.commands[0]?.hostCommands[0]?.executable, process.execPath);
  const behaviorCall = history.commands[0]?.hostCommands.at(-1);
  const schemaFlag = behaviorCall?.args.indexOf("--schema") ?? -1;
  assert.ok(schemaFlag >= 0);
  assert.equal(
    behaviorCall?.args[schemaFlag + 1],
    join(codebaseRoot, "gurusdk-framework", "contracts", "schemas"),
  );
  assert.match(history.commands[0]?.hostCommands.at(-1)?.result.stdout ?? "", /^\[RESULT\]/);

  assert.equal(coordinatorMessages.length, 1);
  const historyObservation = attachments.readTagBlock(
    coordinatorMessages[0] ?? "",
    CoordinatorContextTags.Observation,
  )[0]?.body ?? "";
  assert.match(historyObservation, /### RBT Execution History Ready/);
  assert.ok(historyObservation.includes('executor_history_ref: {"workflowId":"workflow-001","agentId":"executor","internalSymbols":["history","001.json"]}'));
  assert.ok(historyObservation.includes(`execute_file_ref: ${JSON.stringify(executeInput)}`));
  assert.match(historyObservation, /campaign_id: account\.restore\.success\/campaign\/main/);
  assert.match(historyObservation, /scenario_id: account\.restore\.success/);
  assert.match(historyObservation, /status: completed/);

  assert.equal("recordObject" in domain, true);

  const replay = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-execute-file-replay",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { execute_file: executeInput },
    role: "executor",
  }));
  assert.equal(replay?.success, true);
  assert.deepEqual(readdirSync(historyRoot).sort(), ["001.json", "002.json"]);
  const replayHistory = JSON.parse(readFileSync(join(historyRoot, "002.json"), "utf8")) as {
    runtimeSequence: number;
    executeFileRef: string;
    platform?: unknown;
  };
  assert.equal(replayHistory.runtimeSequence, 2);
  assert.deepEqual(replayHistory.executeFileRef, history.executeFileRef);
  assert.deepEqual(replayHistory.platform, history.platform);
  assert.equal(coordinatorMessages.length, 2);
  assert.deepEqual([...new RbtDomainProjector().project(domain.recordObject.read()).artifacts.histories.values()].map(({ history }) => history.runtimeSequence), [1, 2]);
  assert.equal(readFileSync(executeFilePath, "utf8"), originalInput);
  if (inputOwner === "historical") {
    assert.equal(existsSync(join(sourceRoot, "history")), false);
    assert.equal(existsSync(join(roots.artifactRoot, "account-anon-restore-existing-account")), false);
  }
});
}

test("RBT execute-file rejects an array-shaped evidenceCapture before Runtime", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-evidence-capture-contract",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem(),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: {
      ...roots,
      readableRoots: [codebaseRoot],
      shellTools: [],
    },
  }));
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const { executeFilePath } = writeTestExecuteFile(roots.artifactRoot);
  const executeFile = JSON.parse(readFileSync(executeFilePath, "utf8")) as {
    commands: Array<{ payload: Record<string, unknown> }>;
  };
  executeFile.commands[1]!.payload.evidenceCapture = [];
  writeFileSync(executeFilePath, `${JSON.stringify(executeFile, null, 2)}\n`, "utf8");

  const response = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-invalid-evidence-capture",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { execute_file: { workflowId: "workflow-001", agentId: "executor", internalSymbols: ["pack", "execute-file.json"] } },
    role: "executor",
  }));

  assert.equal(response?.success, false);
  assert.match(
    response?.contentItems[0]?.text ?? "",
    /behavior\.scenario\.activate payload\.evidenceCapture must be an object\./,
  );
});

test("RBT execute-file preflights every registry identity before campaign mutation", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-identity-preflight",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem(),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  const campaignEvents: string[] = [];
  eventBus.subscribe(RbtEvents.campaign, (event) => {
    campaignEvents.push(event.key.routeKey);
  });
  const { executeFilePath } = writeTestExecuteFile(roots.artifactRoot);
  const executeFile = JSON.parse(readFileSync(executeFilePath, "utf8")) as {
    commands: Array<{ payload: Record<string, unknown> }>;
  };
  executeFile.commands[1]!.payload = {
    scenarioId: "account.restore.success",
    rootId: "missing.root",
    activations: [{ id: "missing.activation", variantId: "missing.variant", params: {} }],
    evidenceCapture: {
      enabled: true,
      sources: ["missing.filter.source"],
      captures: [{
        captureId: "capture-before",
        nodeId: "missing.capture.node",
        timing: "before",
        variantId: "missing.capture.variant",
        sourceId: "missing.capture.source",
        kind: "state_snapshot",
      }],
    },
  };
  executeFile.commands[2]!.payload = {
    scenarioId: "account.restore.success",
    triggerCommandId: "missing.trigger",
    params: {},
  };
  writeFileSync(executeFilePath, `${JSON.stringify(executeFile, null, 2)}\n`, "utf8");
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const response = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-identity-preflight",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { execute_file: { workflowId: "workflow-001", agentId: "executor", internalSymbols: ["pack", "execute-file.json"] } },
    role: "executor",
  }));

  assert.equal(response?.success, false);
  const output = JSON.parse(response?.contentItems[0]?.text ?? "null") as {
    executedCommands: number;
    error: { sequence: number; command: string; code: string; message: string };
  };
  assert.equal(output.executedCommands, 0);
  assert.equal(output.error.sequence, 0);
  assert.equal(output.error.command, "behavior.registry.manifest");
  assert.equal(output.error.code, "identity_preflight_failed");
  for (const identity of [
    "rootId missing.root",
    "activation id missing.activation",
    "variant missing.activation/missing.variant",
    "sourceId missing.filter.source",
    "capture nodeId missing.capture.node",
    "capture sourceId missing.capture.source",
    "capture variant missing.capture.node/missing.capture.variant",
    "triggerCommandId missing.trigger",
  ]) assert.match(output.error.message, new RegExp(identity.replaceAll(".", "\\.")));
  assert.deepEqual(campaignEvents, []);
  assert.equal(existsSync(join(roots.artifactRoot, "history")), false);
});

test("RBT execute-file continues the sequence when campaign history publication fails", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-history-publication-failure",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem(),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  let publicationFailure = true;
  eventBus.subscribe(RbtEvents.campaign.start, () => {
    if (publicationFailure) {
      publicationFailure = false;
      throw new Error("campaign history sink unavailable");
    }
  });
  const { executeFilePath } = writeTestExecuteFile(roots.artifactRoot);
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const response = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-execute-file-history-publication-failure",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { execute_file: { workflowId: "workflow-001", agentId: "executor", internalSymbols: ["pack", "execute-file.json"] } },
    role: "executor",
  }));

  assert.equal(response?.success, false);
  const output = JSON.parse(response?.contentItems[0]?.text ?? "null") as {
    status: string;
    operation: string;
    executedCommands: number;
    error: { code: string; message: string };
  };
  assert.equal(output.status, "failed");
  assert.equal(output.operation, "execute_file");
  assert.equal(output.executedCommands, 5);
  assert.deepEqual(output.error, {
    sequence: 1,
    command: "behavior.campaign.start",
    code: "campaign_history_write_failed",
    message: "campaign history sink unavailable",
  });

  const history = JSON.parse(
    readFileSync(join(roots.artifactRoot, "history", "001.json"), "utf8"),
  ) as { status: string; commands: Array<{ request: { type: string } }> };
  assert.equal(history.status, "completed");
  assert.deepEqual(history.commands.map((command) => command.request.type), [
    "behavior.campaign.start",
    "behavior.scenario.activate",
    "behavior.trigger.invoke",
    "behavior.scenario.deactivate",
    "behavior.campaign.stop",
  ]);
});

test("RBT campaign history continues after the greatest existing runtime sequence", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-history-resume",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem(),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  const historyRoot = join(roots.artifactRoot, "history");
  mkdirSync(historyRoot, { recursive: true });
  writeFileSync(join(historyRoot, "007.json"), "{}\n", "utf8");
  const { executeFilePath } = writeTestExecuteFile(roots.artifactRoot);
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const response = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-execute-file-after-resume",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { execute_file: { workflowId: "workflow-001", agentId: "executor", internalSymbols: ["pack", "execute-file.json"] } },
    role: "executor",
  }));

  assert.equal(response?.success, true);
  assert.deepEqual(readdirSync(historyRoot).sort(), ["007.json", "008.json"]);
  const history = JSON.parse(readFileSync(join(historyRoot, "008.json"), "utf8")) as {
    runtimeSequence: number;
  };
  assert.equal(history.runtimeSequence, 8);
});

test("RBT execute-file performs cleanup after a command failure and closes failed history", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain({ failedCommand: "behavior.trigger.invoke" });
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-cleanup",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem(),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  const { executeFilePath } = writeTestExecuteFile(roots.artifactRoot);
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const response = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-execute-file-failure",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { execute_file: { workflowId: "workflow-001", agentId: "executor", internalSymbols: ["pack", "execute-file.json"] } },
    role: "executor",
  }));

  assert.equal(response?.success, false);
  const output = JSON.parse(response?.contentItems[0]?.text ?? "null") as {
    executedCommands: number;
    error: { sequence: number; command: string; code: string };
  };
  assert.equal(output.executedCommands, 5);
  assert.deepEqual(output.error, {
    sequence: 3,
    command: "behavior.trigger.invoke",
    code: "forced_failure",
    message: "Forced failure.",
  });

  const [historyName] = readdirSync(join(roots.artifactRoot, "history"));
  assert.ok(historyName);
  const history = JSON.parse(
    readFileSync(join(roots.artifactRoot, "history", historyName), "utf8"),
  ) as { status: string; commands: Array<{ request: { type: string }; status: string }> };
  assert.equal(history.status, "failed");
  assert.deepEqual(history.commands.map((command) => [command.request.type, command.status]), [
    ["behavior.campaign.start", "completed"],
    ["behavior.scenario.activate", "completed"],
    ["behavior.trigger.invoke", "failed"],
    ["behavior.scenario.deactivate", "completed"],
    ["behavior.campaign.stop", "completed"],
  ]);
});

test("RBT behavior execution rejects operations outside its business Phases", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = new RbtDomain();
  await installTestRunScope(t, {
    runId: "run-rbt-unregistered-phase-tool",
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
  });

  return domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-unregistered-phase-tool",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { command: "behavior.node.variants", payload: { id: "node" } },
    role: "coordinator",
  })).then((response) => {
    assert.equal(response?.success, false);
    assert.match(
      response?.contentItems[0]?.text ?? "",
      /Behavioral operations are not available in RBT Phase Synthesis/,
    );
  });
});

test("RBT Domain rejects mutating behavior commands from a review role", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = new RbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-review-boundary",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
  });
  const roots = roleRoots(scope.runRoot, "reviewer");
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    reviewer: { ...roots, readableRoots: [], shellTools: [] },
  }));
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const response = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-review-trigger",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.trigger.invoke",
      payload: { triggerCommandId: "account.restore.trigger", params: {} },
    },
    role: "reviewer",
  }));

  assert.equal(response?.success, false);
  assert.match(response?.contentItems[0]?.text ?? "", /not available in the current RBT Phase/);
});

test("RBT Reviewer queries a campaign using the Executor-bound schema without codebase access", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain({
    executionRequest: () => ({
      transport: "unity-pipeline",
      platform: "unity_editor",
    }),
  });
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-review-campaign",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem(),
  });
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: {
      ...roleRoots(scope.runRoot, "executor"),
      readableRoots: [codebaseRoot],
      shellTools: [],
    },
    reviewer: {
      ...roleRoots(scope.runRoot, "reviewer"),
      readableRoots: [],
      shellTools: [],
    },
  }));
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const payload = { campaignId: "campaign-review", scenarioId: "scenario-review", includeEvidence: true };
  const executeResponse = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-review-campaign-prepare-runtime",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.registry.nodes",
      payload: { domain: "Growth", category: "RemoteConfig" },
    },
    role: "executor",
  }));
  const response = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-review-campaign",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { command: "behavior.campaign.query", payload },
    role: "reviewer",
  }));

  assert.equal(executeResponse?.success, true);
  assert.equal(response?.success, true);
  assert.deepEqual(JSON.parse(response?.contentItems[0]?.text ?? "null"), {
    status: "completed",
    command: "behavior.campaign.query",
    result: payload,
  });
  assert.deepEqual(scope.environment.agents.reviewer?.mount.readableRoots, []);
});

test("RBT Domain projects a Runtime error without exposing its result envelope", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain({
    executionRequest: () => ({
      transport: "unity-pipeline",
      platform: "unity_editor",
    }),
  });
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-debug-gate",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem(),
  });
  const roots = roleRoots(scope.runRoot, "reviewer");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: {
      ...roleRoots(scope.runRoot, "executor"),
      readableRoots: [codebaseRoot],
      shellTools: [],
    },
    reviewer: { ...roots, readableRoots: [], shellTools: [] },
  }));
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());

  const executeResponse = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-debug-required-prepare-runtime",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.registry.nodes",
      payload: { domain: "Growth", category: "RemoteConfig" },
    },
    role: "executor",
  }));
  const response = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-debug-required",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.evidence.query",
      payload: { sourceId: "<source-id>" },
    },
    role: "reviewer",
  }));

  assert.equal(executeResponse?.success, true);
  assert.equal(response?.success, false);
  const output = JSON.parse(response?.contentItems[0]?.text ?? "null") as {
    status: string;
    command: string;
    error: { code: string; message: string };
  };
  assert.deepEqual(output, {
    status: "failed",
    command: "behavior.evidence.query",
    error: {
      code: "debug_required",
      message: "DebugMode is required.",
    },
  });
});

test("RBT Behavior reconnects and retries one read-only query after a disconnected session", async (t) => {
  const eventBus = new InMemoryEventBus();
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-reconnect-test-"));
  const runRoot = join(root, "run-rbt-query-reconnect");
  const markerPath = join(runRoot, "query-disconnected-once");
  const domain = new RbtDomain({
    ...fakeJarvisReconnectRuntimeOptions(markerPath),
    executionRequest: () => ({ transport: "unity-pipeline", platform: "unity_editor" }),
  });
  const scope = await installTestRunScope(t, {
    runId: "run-rbt-query-reconnect",
    runRoot,
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    runtimeGraph: rbtGraph(eventBus),
    executionSystem: fakeExecutionSystem(),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  await domain.start();
  await domain.run();
  t.after(() => domain.stop());
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const response = await domain.backend.handleDynamicToolCall(dynamicCall({
    callId: "call-query-reconnect",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.node.variants",
      payload: { id: "account.account_auth.restore" },
    },
    role: "executor",
  }));

  assert.equal(response?.success, true);
  const hostOperations = readFileSync(`${markerPath}.calls`, "utf8")
    .trim()
    .split("\n");
  assert.equal(hostOperations.filter((operation) => operation === "connect").length, 2);
  assert.equal(hostOperations.filter((operation) => operation === "disconnect").length, 1);
  assert.equal(hostOperations.filter((operation) => operation === "call").length, 2);
});

function rbtGraph(_eventBus: InMemoryEventBus): Graph {
  return createTestGraph(createGraphData({
    domain: "rbt",
    workflowProfile: "rbt",
    phases: [
      { name: "execute", edges: { completed: "review", error: null }, roles: ["executor"] },
      { name: "review", edges: { completed: null, error: "execute" }, roles: ["reviewer"] },
    ],
    roles: [
      { name: "coordinator", phases: ["Synthesis"] },
      { name: "executor", phases: ["execute"] },
      { name: "reviewer", phases: ["review"] },
    ],
    currentPhase: "execute",
  }));
}

function roleRoots(runRoot: string, role: string): {
  artifactRoot: string;
  logsRoot: string;
} {
  return {
    artifactRoot: join(runRoot, "workflows", "test--workflow-001", "agents", role, "artifacts"),
    logsRoot: join(runRoot, "workflows", "test--workflow-001", "agents", role, "logs"),
  };
}

function installBehaviorSchema(runRoot: string): string {
  const codebaseRoot = join(runRoot, "codebase", "gurusdk-unity");
  const schemaRoot = join(
    codebaseRoot,
    "gurusdk-framework",
    "contracts",
    "schemas",
  );
  const schemaPath = join(
    schemaRoot,
    "behavioral",
    "behavior-control.schema.json",
  );
  mkdirSync(schemaRoot, { recursive: true });
  mkdirSync(join(schemaPath, ".."), { recursive: true });
  writeFileSync(schemaPath, "{}\n", "utf8");
  return codebaseRoot;
}

function rbtEnvironment(
  runId: string,
  roles: Record<string, {
    artifactRoot: string;
    logsRoot: string;
    readableRoots: string[];
    shellTools: ShellToolContract[];
  }>,
): RunEnvironment {
  return {
    agents: Object.fromEntries(Object.entries(roles).map(([role, input]) => [role, {
      role,
      mount: {
        artifactRoot: input.artifactRoot,
        logsRoot: input.logsRoot,
        readableRoots: input.readableRoots,
        shellTools: input.shellTools,
      },
    }])),
    rootAccess: { mountRoots: [], readableRoots: [], writableRoots: [] },
    contextBundle: {
      contextBundleId: `context-${runId}`,
      runId,
      assetCommit: {},
      sharedInputs: {
        mountRoot: "/mount",
        manifestPath: "/mount/manifest.json",
        resourceHash: "rbt",
      },
    },
  } as unknown as RunEnvironment;
}

function dynamicCall(input: {
  callId: string;
  namespace: string;
  tool: string;
  arguments: unknown;
  role: string;
  phase?: string;
}) {
  return {
    input: {
      threadId: `thread-${input.role}`,
      turnId: `turn-${input.role}`,
      callId: input.callId,
      namespace: input.namespace,
      tool: input.tool,
      arguments: input.arguments,
    },
    caller: {
      agentId: input.role,
      role: input.role,
      phase: input.phase ?? (input.role === "executor"
        ? "execute"
        : input.role === "reviewer"
          ? "review"
          : "Synthesis"),
      threadId: `thread-${input.role}`,
    },
  };
}

function rbtDomain(input: Pick<RbtDomainRuntimeOptions, "websocket" | "executionRequest"> & {
  failedCommand?: string;
} = {}): RbtDomain {
  return new RbtDomain({
    ...(input.websocket ? { websocket: input.websocket } : {}),
    executionRequest: input.executionRequest ?? (() => ({ transport: "unity-pipeline", platform: "unity_editor" })),
    executable: process.execPath,
    baseArgs: ["-e", fakeJarvisScript(input.failedCommand), "--"],
  });
}

function writeTestExecuteFile(artifactRoot: string): {
  campaignId: string;
  executeFilePath: string;
} {
  const campaignId = "account.restore.success/campaign/main";
  const scenarioId = "account.restore.success";
  const executeFilePath = join(
    artifactRoot,
    "pack",
    "execute-file.json",
  );
  mkdirSync(join(executeFilePath, ".."), { recursive: true });
  writeFileSync(executeFilePath, `${JSON.stringify({
    bddId: "account-anon-restore-existing-account", targetVersion: "26.7.0-rc.2",
    commands: [
      {
        command: "behavior.campaign.start",
        payload: { campaignId, scenarioId },
      },
      {
        command: "behavior.scenario.activate",
        payload: {
          scenarioId,
          rootId: "account.account_auth.restore",
          activations: [{
            id: "account.account_auth.load_account",
            variantId: "existing_local_user_with_anonymous_credential",
            params: {},
          }],
        },
      },
      {
        command: "behavior.trigger.invoke",
        payload: { scenarioId, triggerCommandId: "account.restore.trigger", params: {} },
      },
      {
        command: "behavior.scenario.deactivate",
        payload: { scenarioId },
      },
      {
        command: "behavior.campaign.stop",
        payload: { campaignId },
      },
    ],
  }, null, 2)}\n`, "utf8");
  return { campaignId, executeFilePath };
}

function fakeJarvisScript(failedCommand?: string): string {
  return [
    "const args = process.argv.slice(1);",
    "const sessionIndex = args.indexOf('--session');",
    "const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : 'session';",
    "if (args.includes('status')) {",
    "  process.stdout.write('WS session ' + sessionId + ': connected url=ws://127.0.0.1:8083 idle=1\\n');",
    "} else if (args.includes('schema') && args.includes('call')) {",
    "  const index = args.indexOf('--params-json');",
    "  const request = JSON.parse(args[index + 1]);",
    "  const payload = request.payload;",
    "  const manifest = {",
    "    schemaVersion: 2,",
    "    registryHash: 'test-registry',",
    "    nodes: [{ id: 'account.account_auth.restore' }, { id: 'account.account_auth.load_account' }],",
    "    variants: [{ id: 'account.account_auth.load_account', variantId: 'existing_local_user_with_anonymous_credential' }],",
    "    sources: [{ sourceId: 'account.restore.source' }],",
    "    triggerCommands: [{ triggerCommandId: 'account.restore.trigger', relatedBehaviorId: 'account.account_auth.restore' }]",
    "  };",
    "  const debugRequired = payload.sourceId === '<source-id>';",
    `  const forcedFailure = request.type === ${JSON.stringify(failedCommand ?? "")};`,
    "  const failed = debugRequired || forcedFailure;",
    "  const result = {",
    "    type: 'behavior.command.result',",
    "    version: 1,",
    "    correlationId: request.correlationId,",
    "    status: failed ? 'error' : 'ok',",
    "    code: debugRequired ? 'debug_required' : forcedFailure ? 'forced_failure' : 'ok',",
    "    payload: debugRequired ? { message: 'DebugMode is required.' } : forcedFailure ? { message: 'Forced failure.' } : request.type === 'behavior.registry.manifest' ? { manifest } : payload",
    "  };",
    "  process.stdout.write('[RESULT] ' + JSON.stringify(result) + '\\n');",
    "} else {",
    "  process.stdout.write('ok\\n');",
    "}",
  ].join("\n");
}

function fakeExecutionSystem(input: {
  identity?: ExecutionPlatformIdentity;
  onIdentify?: (request?: ExecutionPlatformRequest) => void;
  onLaunch?: (request?: ExecutionPlatformRequest) => void;
  onShutdown?: (request?: ExecutionPlatformRequest) => void;
  launchFailure?: { code: string; message: string };
} = {}): ExecutionPlatformPort {
  const identity: ExecutionPlatformIdentity = input.identity ?? {
    type: "unity_editor",
    version: "6000.0.80f1",
  };
  const selection = {
    transport: identity.type === "android" ? "adb" : "unity-pipeline",
    platform: identity,
  };
  return {
    async identify(request = {}, options = {}) {
      input.onIdentify?.(request);
      const result = { ok: true as const, selection };
      await currentRunScope().eventBus.publishAndWait(ExecutionEvents.execution.identifyCompleted, {
        correlationId: options.correlationId ?? "fake-identify",
        request,
        result,
      });
      return { ok: true, identity };
    },
    async launch(request = {}, options = {}) {
      input.onLaunch?.(request);
      const result = input.launchFailure
        ? { ok: false as const, ...input.launchFailure }
        : { ok: true as const, selection };
      await currentRunScope().eventBus.publishAndWait(ExecutionEvents.execution.launchCompleted, {
        correlationId: options.correlationId ?? "fake-launch",
        request,
        result,
      });
      return result.ok ? { ok: true, identity } : result;
    },
    async shutdown(request = {}, options = {}) {
      input.onShutdown?.(request);
      await currentRunScope().eventBus.publishAndWait(ExecutionEvents.execution.shutdownCompleted, {
        correlationId: options.correlationId ?? "fake-shutdown",
        request,
        result: { ok: true, selection },
      });
      return { ok: true, identity };
    },
  };
}

function appPilotIdentityResponse(identity: ExecutionPlatformIdentity) {
  return {
    ok: true as const,
    value: {
      transport: "unity-pipeline",
      platform: { type: identity.type, version: identity.version },
    },
  };
}

function baseDomain(scope: RunScope): BaseDomain {
  const domain = scope.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(domain instanceof BaseDomain);
  return domain;
}

function fakeJarvisReconnectRuntimeOptions(markerPath: string): RbtDomainRuntimeOptions {
  const script = [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(1);",
    `const callsPath = ${JSON.stringify(`${markerPath}.calls`)};`,
    `const connectedPath = ${JSON.stringify(`${markerPath}.connected`)};`,
    "const operation = args.includes('connect') ? 'connect' : args.includes('disconnect') ? 'disconnect' : args.includes('call') ? 'call' : 'other';",
    "fs.appendFileSync(callsPath, operation + '\\n');",
    "const sessionIndex = args.indexOf('--session');",
    "const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : 'session';",
    "if (args.includes('status')) {",
    "  process.stdout.write(fs.existsSync(connectedPath)",
    "    ? 'WS session ' + sessionId + ': connected url=ws://127.0.0.1:8083 idle=1\\n'",
    "    : 'WS session ' + sessionId + ': disconnected\\n');",
    "} else if (args.includes('connect')) {",
    "  fs.writeFileSync(connectedPath, 'connected\\n');",
    "  process.stdout.write('ok\\n');",
    "} else if (args.includes('disconnect')) {",
    "  fs.rmSync(connectedPath, { force: true });",
    "  process.stdout.write('ok\\n');",
    "} else if (args.includes('schema') && args.includes('call')) {",
    "  const index = args.indexOf('--params-json');",
    "  const request = JSON.parse(args[index + 1]);",
    `  const markerPath = ${JSON.stringify(markerPath)};`,
    "  if (!fs.existsSync(markerPath)) {",
    "    fs.writeFileSync(markerPath, 'disconnected\\n');",
    "    fs.rmSync(connectedPath, { force: true });",
    "    process.stderr.write('[ERROR] WS session test is not connected. Run jarvis ws connect first.\\n');",
    "    process.exitCode = 1;",
    "  } else {",
    "    process.stdout.write('[RESULT] ' + JSON.stringify({",
    "      type: 'behavior.command.result',",
    "      version: 1,",
    "      correlationId: request.correlationId,",
    "      status: 'ok',",
    "      code: 'ok',",
    "      payload: request.payload",
    "    }) + '\\n');",
    "  }",
    "} else {",
    "  process.stdout.write('ok\\n');",
    "}",
  ].join("\n");
  return {
    executable: process.execPath,
    baseArgs: ["-e", script, "--"],
  };
}
