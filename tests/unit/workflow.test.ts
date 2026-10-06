import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildWorkflow,
} from "../../src/asset-store/index.js";
import { WorkflowBuilder } from "../../src/asset-store/builders/workflow-builder.js";
import { parseWorkflowProfile } from "../../src/asset-store/assets/workflow-profiles.js";
import type { WorkflowProfileAsset, WorkflowResourcePark } from "../../src/asset-store/contracts/workflow-profile.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import {
  Phase,
  Workflow,
  WorkflowEvents,
} from "../../src/core/workflow/index.js";
import { AgentTaskDispositionKinds, AgentTaskStatuses, type AgentTaskState } from "../../src/agent/task/types.js";
import { AgentStepStatuses, type AgentStepState } from "../../src/agent/step/types.js";
import { projectGraphData } from "../../src/core/workflow/projector/graph-projector.js";
import { createTestRunPersistence, installTestRunScope, createDefaultTestGraph, createTestGraph } from "../helpers/run-persistence.js";
import {
  createDomainRuntime,
  DomainAgentBackend,
  ScoutDomainId,
} from "../../src/domain/index.js";
import { RbtDomain, RbtDomainAgentBackend, RbtRecordObject } from "../../src/domain/domains/rbt/index.js";

const scoutRoot = process.cwd();
const profilePath = join(
  scoutRoot,
  "assets",
  "scout",
  "workflows",
  "rbt.json",
);

test("Workflow Asset stays static while each Graph independently owns its cursor", () => {
  const asset = buildWorkflow(scoutRoot, "rbt");
  const before = structuredClone(asset);
  assert.equal(Object.hasOwn(asset, "currentPhase"), false);
  assert.equal(Object.hasOwn(asset.profile, "currentPhase"), false);
  const first = new Workflow(asset);
  const second = new Workflow(asset);
  assert.equal(first.profileAsset, asset);
  assert.deepEqual(asset.profile.roles.executor!.artifactReaders, ["reviewer"]);
  const initial = first.graph.initialSnapshot();
  const advanced = first.graph.advance("completed");
  assert.notEqual(advanced.state.currentPhase, initial.currentPhase);
  assert.deepEqual(second.graph.snapshot(), initial);
  assert.deepEqual(asset, before);
  first.graph.restore(initial);
  assert.deepEqual(first.graph.snapshot(), initial);
  assert.throws(() => first.graph.restore({ ...initial, currentPhase: "unknown" }), /not declared/);
  assert.throws(() => first.graph.restore({ ...initial, domain: "other" }), /definition differs/);
  assert.deepEqual(first.graph.snapshot(), initial);
});

test("Graph owns terminal outcomes, distinguishes return edges and restores the same conclusion", () => {
  const graph = createDefaultTestGraph();
  assert.equal(graph.advance("completed").cycleCompleted, false);
  assert.equal(graph.advance("error").cycleCompleted, false);
  assert.equal(graph.snapshot().currentPhase, "research");
  assert.equal(graph.completedOutcome, undefined);
  const active = graph.snapshot();
  assert.throws(() => graph.restore(active, "completed"), /does not select a terminal edge/);
  assert.deepEqual(graph.snapshot(), active);
  assert.equal(graph.completedOutcome, undefined);

  assert.equal(graph.advance("error").cycleCompleted, true);
  assert.equal(graph.completedOutcome, "error");
  assert.throws(() => graph.advance("completed"), /completed Workflow Graph/);
  const restored = createDefaultTestGraph();
  restored.restore(graph.snapshot(), graph.completedOutcome);
  assert.equal(restored.completedOutcome, "error");
  assert.throws(() => restored.previewAdvance("error"), /completed Workflow Graph/);
  restored.initializeGraph();
  assert.equal(restored.completedOutcome, undefined);
  assert.equal(restored.advance("completed").cycleCompleted, false);

  const successful = createDefaultTestGraph();
  for (let index = 0; index < 4; index += 1) successful.advance("completed");
  restored.restore(successful.snapshot(), successful.completedOutcome);
  assert.equal(restored.completedOutcome, "completed");
  assert.throws(() => restored.advance("error"), /completed Workflow Graph/);
});

test("Domain Runtime is selected by the GraphData domain identifier", async () => {
  const rbt = await createDomainRuntime(ScoutDomainId.Rbt);
  assert.ok(rbt instanceof RbtDomain);
  assert.ok(rbt.backend instanceof DomainAgentBackend);
  assert.equal(typeof rbt.recordObject.readAll, "function");
  await assert.rejects(createDomainRuntime("validation" as ScoutDomainId), /Invalid Workflow domain: validation/);
  await assert.rejects(
    createDomainRuntime("missing-domain" as ScoutDomainId),
    /Invalid Workflow domain: missing-domain/,
  );
});

test("Domain loading validates backend methods instead of Domain forwarding methods", async (t) => {
  for (const method of ["handleDynamicToolCall"]) {
    await t.test(method, async () => {
      const prototype = RbtDomainAgentBackend.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
      Object.defineProperty(prototype, method, { value: undefined, configurable: true });
      try {
        await assert.rejects(createDomainRuntime(ScoutDomainId.Rbt), /invalid Domain backend/);
      } finally {
        if (descriptor) Object.defineProperty(prototype, method, descriptor);
        else Reflect.deleteProperty(prototype, method);
      }
    });
  }
});

test("Domain loading validates participant lifecycle methods", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(RbtDomain.prototype, "restore");
  Object.defineProperty(RbtDomain.prototype, "restore", { value: "invalid", configurable: true });
  try {
    await assert.rejects(createDomainRuntime(ScoutDomainId.Rbt), /invalid Domain instance/);
  } finally {
    if (descriptor) Object.defineProperty(RbtDomain.prototype, "restore", descriptor);
    else Reflect.deleteProperty(RbtDomain.prototype, "restore");
  }
});

test("Phase selects the first available role in declaration order", () => {
  const phase = new Phase({
    name: "research",
    edges: { completed: null, error: null },
    roles: ["researcher-a", "researcher-b"],
  });

  assert.equal(phase.selectAvailableRole(() => true), "researcher-a");
  assert.equal(
    phase.selectAvailableRole((role) => role !== "researcher-a"),
    "researcher-b",
  );
  assert.equal(phase.selectAvailableRole(() => false), undefined);
});

test("Workflow persists Graph initialization and restores the latest Phase", async (t) => {
  const eventBus = new InMemoryEventBus();
  const persistence = await createTestRunPersistence(
    t,
    "workflow-journal-projection",
    "/repo",
    eventBus,
  );
  const { journal, workflow } = persistence;
  await installTestRunScope(t, {
    runId: journal.runId, eventBus, workflow, manifestStore: persistence.manifestStore,
  });

  const advanced = await workflow.advance("completed");
  assert.equal(advanced.status, "advanced");
  const events = journal.readAll();
  const initialized = events.find((event) =>
    WorkflowEvents.workflow.initialized.is(event)
  );
  const transition = events.find((event) =>
    WorkflowEvents.workflow.advanced.is(event)
  );

  assert.ok(initialized && WorkflowEvents.workflow.initialized.is(initialized));
  assert.ok(transition && WorkflowEvents.workflow.advanced.is(transition));
  assert.equal(transition.payload.previousPhase, "research");
  assert.equal(transition.payload.outcome, "completed");
  assert.equal(transition.payload.cycleCompleted, false);
  assert.equal(advanced.result.state.currentPhase, "research-reviewer");
  assert.equal(projectGraphData(events).currentPhase, "research-reviewer");
});

for (const outcome of ["completed", "error"] as const) {
  for (const status of Object.values(AgentTaskStatuses)) {
    test(`Workflow ${outcome} checks ${status} Task execution without implicitly releasing it`, async (t) => {
      const graph = createDefaultTestGraph().snapshot();
      const runtimeGraph = createTestGraph({ ...graph, phases: graph.phases.map((phase, index) => index === 0
        ? { ...phase, edges: { ...phase.edges, error: "research-reviewer" } } : phase) });
      const scope = await installTestRunScope(t, { runId: `phase-guard-${outcome}-${status}`, runtimeGraph });
      const workflow = scope.workflow;
      const now = new Date().toISOString();
      const task: AgentTaskState = {
        type: "local_agent", taskId: "phase-task", taskSequence: 1,
        agentId: "researcher", role: "researcher", phase: "research",
        description: "Outstanding work", initialPrompt: "Do the work", status,
        isBackgrounded: true, stepIds: [], dispositions: [], createdAt: now, updatedAt: now,
      };
      const stored = scope.agentOrchestrator.taskStore.addTask(task);
      const beforeGraph = workflow.graph.snapshot();
      const beforeWorkflow = workflow.snapshot();
      const beforeJournal = readFileSync(workflow.journalPath, "utf8");
      const benchmarkPath = join(scope.runRoot, "benchmarks.json");
      const beforeBenchmark = readFileSync(benchmarkPath, "utf8");
      let published = 0;
      scope.eventBus.subscribe(WorkflowEvents.workflow.advanced, () => { published += 1; });

      if (status === AgentTaskStatuses.Queued || status === AgentTaskStatuses.Running) {
        await assert.rejects(async () => await workflow.advance(outcome), /Cannot advance Workflow Phase research: Task phase-task/);
        assert.deepEqual(workflow.graph.snapshot(), beforeGraph);
        assert.deepEqual(workflow.snapshot(), beforeWorkflow);
        assert.equal(readFileSync(workflow.journalPath, "utf8"), beforeJournal);
        assert.equal(readFileSync(benchmarkPath, "utf8"), beforeBenchmark);
        assert.equal(published, 0);
        assert.deepEqual(scope.agentOrchestrator.taskStore.getTask(task.taskId), stored);
        scope.agentOrchestrator.taskStore.updateTask(task.taskId, (current) => ({ ...current, status: AgentTaskStatuses.Done }));
      }

      const advanced = await workflow.advance(outcome);
      assert.equal(advanced.status, "advanced");
      assert.equal(advanced.result.cycleCompleted, false);
      assert.equal(advanced.result.state.currentPhase, "research-reviewer");
      assert.equal(workflow.snapshot()?.status, "active");
      assert.equal(published, 1);
      assert.ok(scope.agentOrchestrator.taskStore.getTask(task.taskId), "Phase advancement does not release the Task");
    });
  }
}

test("Workflow keeps human-waiting and restored earlier-Phase Tasks on the active Workflow", async (t) => {
  const scope = await installTestRunScope(t, { runId: "phase-guard-human-wait" });
  await scope.workflow.advance("completed");
  const now = new Date().toISOString();
  scope.agentOrchestrator.taskStore.addTask({
    type: "local_agent", taskId: "restored-human-task", taskSequence: 1,
    agentId: "researcher", role: "researcher", phase: "research",
    description: "Waiting for a human", initialPrompt: "Need confirmation",
    status: AgentTaskStatuses.Running, isBackgrounded: true,
    stepIds: ["human-request-step"], createdAt: now, updatedAt: now,
    dispositions: [{
      kind: AgentTaskDispositionKinds.WaitingForHuman,
      stepId: "human-request-step", turnId: "human-request-turn", callId: "human-request-call",
      timestamp: now, requestId: "human-request", request: "Confirm the target",
    }],
  });
  const graph = scope.workflow.graph.snapshot();
  const workflowData = scope.workflow.snapshot()!;
  for (const outcome of ["completed", "error"] as const) {
    await assert.rejects(async () => await scope.workflow.advance(outcome), /restored-human-task \(running\)/);
    assert.deepEqual(scope.workflow.graph.snapshot(), graph);
    assert.deepEqual(scope.workflow.snapshot(), workflowData);
    assert.doesNotThrow(() => scope.workflow.assertAcceptingInput());
  }
});

for (const status of [AgentTaskStatuses.Done, AgentTaskStatuses.Failed, AgentTaskStatuses.Stopped]) {
  test(`Workflow waits for a ${status} Task's running Step but not the Coordinator Step`, async (t) => {
    const graph = createDefaultTestGraph().snapshot();
    const runtimeGraph = createTestGraph({ ...graph, phases: graph.phases.map((phase, index) => index === 0
      ? { ...phase, edges: { ...phase.edges, error: "research-reviewer" } } : phase) });
    const scope = await installTestRunScope(t, { runId: `phase-guard-step-${status}`, runtimeGraph });
    const now = new Date().toISOString();
    scope.agentOrchestrator.taskStore.addTask({
      type: "local_agent", taskId: "ended-task", taskSequence: 1,
      agentId: "researcher", role: "researcher", phase: "research",
      description: "Finishing work", initialPrompt: "Work", status,
      isBackgrounded: true, stepIds: ["finishing-step"], dispositions: [], createdAt: now, updatedAt: now,
    });
    const workerStep: AgentStepState = {
      stepId: "finishing-step", agentId: "researcher", taskId: "ended-task",
      status: AgentStepStatuses.Running, prompt: "Work", toolCallIds: [], humanInputReferences: [],
      startedAt: now, updatedAt: now,
    };
    scope.agentOrchestrator.stepStore.restore([
      workerStep,
      { ...workerStep, stepId: "coordinator-step", agentId: "coordinator", taskId: undefined },
    ]);
    const before = scope.workflow.snapshot();
    await assert.rejects(async () => await scope.workflow.advance("error"), /Worker Step finishing-step for Task ended-task is still running/);
    assert.deepEqual(scope.workflow.snapshot(), before);
    scope.agentOrchestrator.stepStore.updateStep(workerStep.stepId, (step) => ({ ...step, status: AgentStepStatuses.Completed }));
    const advanced = await scope.workflow.advance("error");
    assert.equal(advanced.status, "advanced");
    assert.equal(advanced.result.cycleCompleted, false);
    assert.equal(scope.agentOrchestrator.stepStore.getStep("coordinator-step")?.status, AgentStepStatuses.Running);
  });
}

test("GraphData recovery rejects a Run without Workflow initialization", async (t) => {
  const { journal } = await createTestRunPersistence(t, "workflow-missing-initialization");
  const eventsWithoutWorkflow = journal.readAll().filter((event) =>
    !WorkflowEvents.workflow.initialized.is(event)
  );

  assert.throws(
    () => projectGraphData(eventsWithoutWorkflow),
    /missing system\.workflow\.initialized/,
  );
});

test("Workflow Profile validation rejects entry fields and invalid graph references", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-workflow-profile-"));
  const workflowRoot = join(fixtureRoot, "assets", "scout", "workflows");
  const targetPath = join(workflowRoot, "invalid.json");
  mkdirSync(workflowRoot, { recursive: true });
  const original = JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, unknown>;

  try {
    const withEntry = structuredClone(original) as {
      phases: Record<string, unknown>;
    };
    withEntry.phases.entry = "research";
    writeFileSync(targetPath, JSON.stringify(withEntry), "utf8");
    assert.throws(
      () => buildWorkflow(fixtureRoot, "invalid"),
      /unknown phases field\(s\): entry/,
    );

    const withSuccess = structuredClone(original) as {
      phases: { workers: Record<string, { edges: Record<string, unknown> }> };
    };
    withSuccess.phases.workers.execute!.edges.success = "review";
    writeFileSync(targetPath, JSON.stringify(withSuccess), "utf8");
    assert.throws(
      () => buildWorkflow(fixtureRoot, "invalid"),
      /unknown phases\.workers\.execute\.edges field\(s\): success/,
    );

    const withUnknownTarget = structuredClone(original) as {
      phases: { workers: Record<string, { edges: { completed: string } }> };
    };
    withUnknownTarget.phases.workers.execute!.edges.completed = "missing";
    writeFileSync(targetPath, JSON.stringify(withUnknownTarget), "utf8");
    assert.throws(
      () => buildWorkflow(fixtureRoot, "invalid"),
      /references unknown Worker Phase missing/,
    );

    for (const reservedPhase of ["Internal", "Synthesis"]) {
      const withReservedWorkerPhase = structuredClone(original) as {
        phases: { workers: Record<string, unknown> };
      };
      withReservedWorkerPhase.phases.workers[reservedPhase] = {
        edges: { completed: null, error: null },
      };
      writeFileSync(targetPath, JSON.stringify(withReservedWorkerPhase), "utf8");
      assert.throws(
        () => buildWorkflow(fixtureRoot, "invalid"),
        new RegExp(`cannot declare reserved Phase ${reservedPhase}`),
      );
    }

    const coordinatorWithPhase = structuredClone(original) as {
      roles: { coordinator: { phases?: string[] } };
    };
    coordinatorWithPhase.roles.coordinator.phases = ["execute"];
    writeFileSync(targetPath, JSON.stringify(coordinatorWithPhase), "utf8");
    assert.throws(
      () => buildWorkflow(fixtureRoot, "invalid"),
      /roles\.coordinator cannot declare phases/,
    );

    const withUnknownReader = structuredClone(original) as { roles: { executor: { artifactReaders: string[] } } };
    withUnknownReader.roles.executor.artifactReaders = ["missing-reader"];
    writeFileSync(targetPath, JSON.stringify(withUnknownReader), "utf8");
    assert.throws(() => buildWorkflow(fixtureRoot, "invalid"), /artifactReaders references unknown role missing-reader/);

    const withoutDefaultResource = structuredClone(original) as {
      resources: Record<string, { default?: true; phases: string[] }>;
    };
    delete withoutDefaultResource.resources["common-inspection"]!.default;
    withoutDefaultResource.resources["common-inspection"]!.phases = ["Synthesis"];
    writeFileSync(targetPath, JSON.stringify(withoutDefaultResource), "utf8");
    assert.doesNotThrow(() => buildWorkflow(fixtureRoot, "invalid"));

    const withTwoDefaultResources = structuredClone(original) as {
      resources: Record<string, { default?: true }>;
    };
    withTwoDefaultResources.resources["rbt-execution"]!.default = true;
    writeFileSync(targetPath, JSON.stringify(withTwoDefaultResources), "utf8");
    assert.throws(
      () => buildWorkflow(fixtureRoot, "invalid"),
      /at most one global default Resource Park; found 2/,
    );

    const withUnknownResourcePhase = structuredClone(original) as {
      resources: Record<string, { phases: string[] }>;
    };
    withUnknownResourcePhase.resources["rbt-execution"]!.phases.push("missing");
    writeFileSync(targetPath, JSON.stringify(withUnknownResourcePhase), "utf8");
    assert.throws(
      () => buildWorkflow(fixtureRoot, "invalid"),
      /resources\.rbt-execution references unknown Phase missing/,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("WorkflowBuilder inherits the default Resource Park when its Phase scope allows it", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-workflow-default-resource-"));
  const workflowRoot = join(fixtureRoot, "assets", "scout", "workflows");
  const targetPath = join(workflowRoot, "fallback.json");
  mkdirSync(workflowRoot, { recursive: true });
  const profile = JSON.parse(readFileSync(profilePath, "utf8")) as {
    phases: { workers: Record<string, unknown> };
    roles: Record<string, unknown>;
    resources: Record<string, { phases: string[] }>;
  };
  profile.resources["common-inspection"]!.phases = [];
  profile.phases.workers.fallback = {
    edges: { completed: null, error: null },
  };
  profile.roles["fallback-worker"] = {
    phases: ["fallback"],
    multiAgent: false,
    customAgents: [],
  };
  writeFileSync(targetPath, JSON.stringify(profile), "utf8");

  try {
    const asset = buildWorkflow(fixtureRoot, "fallback");
    const agentProfile = new WorkflowBuilder(asset).buildAgentProfile("fallback-worker");
    assert.deepEqual(agentProfile.resourceParks, ["common-inspection"]);
    assert.deepEqual(agentProfile.dynamicTools, []);
    assert.deepEqual(new Workflow(asset).dynamicToolNamesForPhase("fallback"), []);
    assert.deepEqual(agentProfile.shellTools, [
      "scoutAssets",
      "scoutMemory",
      "cat",
      "sed",
      "pwd",
    ]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("Workflow Profile requires Dynamic Tool names at the configuration boundary", () => {
  const original = JSON.parse(readFileSync(profilePath, "utf8")) as {
    resources: Record<string, Record<string, unknown>>;
  };
  for (const [value, message] of [
    [undefined, /dynamicTools must be an array/],
    [{}, /dynamicTools must be an array/],
    [[null], /dynamicTools item must be a non-empty string/],
    [[" "], /dynamicTools item must be a non-empty string/],
    [[1], /dynamicTools item must be a non-empty string/],
    [[{ namespace: null, name: "Probe" }], /dynamicTools item must be a non-empty string/],
  ] as const) {
    const profile = structuredClone(original);
    profile.resources["rbt-execution"]!.dynamicTools = value;
    assert.throws(() => parseWorkflowProfile(profile, "configured-workflow.json"), message);
  }
  const profile = structuredClone(original);
  profile.resources["rbt-execution"]!.dynamicTools = ["Probe"];
  assert.deepEqual(
    parseWorkflowProfile(profile, "configured-workflow.json").resources["rbt-execution"]!.dynamicTools,
    ["Probe"],
  );
});

test("Workflow provides Phase tool names consistent with built profiles, Resource Park scope and deduplication", () => {
  const source = buildWorkflow(scoutRoot, "rbt");
  const emptyPark: WorkflowResourcePark = {
    phases: [], shellTools: [], dynamicTools: [], mcpServers: [], plugins: [], readableRoots: [], writableRoots: [],
  };
  const shared = "SharedProbe";
  const execute = "ExecuteProbe";
  const review = "ReviewProbe";
  const asset: WorkflowProfileAsset = {
    ...source,
    profile: {
      ...source.profile,
      roles: {
        coordinator: source.profile.roles.coordinator!,
        auditor: { phases: ["execute", "review"], multiAgent: false, customAgents: [] },
      },
      resources: {
        common: { ...emptyPark, default: true, dynamicTools: [shared] },
        execute: { ...emptyPark, phases: ["execute"], dynamicTools: [shared, execute] },
        review: { ...emptyPark, phases: ["review"], dynamicTools: [review] },
        synthesis: { ...emptyPark, phases: ["Synthesis"], dynamicTools: [] },
      },
    },
  };
  const builder = new WorkflowBuilder(asset);
  const workflow = new Workflow(asset);
  assert.equal(workflow.snapshot(), undefined);
  assert.deepEqual(workflow.dynamicToolNamesForPhase("execute"), [shared, execute]);
  assert.deepEqual(workflow.dynamicToolNamesForPhase("review"), [shared, review]);
  assert.deepEqual(workflow.dynamicToolNamesForPhase("Synthesis"), [shared]);
  assert.deepEqual(workflow.dynamicToolNamesForPhase("undeclared"), []);
  assert.deepEqual(builder.buildAgentProfile("auditor").dynamicTools, [shared, execute, review]);
  const references = workflow.dynamicToolNamesForPhase("execute");
  references[0] = "Changed";
  assert.deepEqual(workflow.dynamicToolNamesForPhase("execute"), [shared, execute]);

  const rbtBuilder = new WorkflowBuilder(source);
  const rbtWorkflow = new Workflow(source);
  assert.deepEqual(rbtWorkflow.dynamicToolNamesForPhase("Synthesis"), [
    "StartWorkflow", "ResolveArtifactReference", "AssignTask", "SendMessage", "RespondHumanInput", "SubmitPhaseOutcome",
  ]);
  assert.deepEqual(
    rbtBuilder.buildAgentProfile("executor").dynamicTools,
    rbtWorkflow.dynamicToolNamesForPhase("execute"),
  );
  assert.deepEqual(
    rbtBuilder.buildAgentProfile("reviewer").dynamicTools,
    rbtWorkflow.dynamicToolNamesForPhase("review"),
  );
  assert.equal(rbtWorkflow.dynamicToolNamesForPhase("execute").includes("ExecutionPlatform"), false);
  assert.equal(rbtWorkflow.dynamicToolNamesForPhase("review").includes("ExecutionPlatform"), true);
  assert.equal(rbtWorkflow.dynamicToolNamesForPhase("execute").includes("SearchExecutionPack"), true);
  assert.equal(rbtWorkflow.dynamicToolNamesForPhase("review").includes("SearchExecutionPack"), false);
  assert.equal(rbtWorkflow.dynamicToolNamesForPhase("Synthesis").includes("SearchExecutionPack"), false);
});

test("WorkflowBuilder rejects a role Phase with no projected Resource Park", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-workflow-missing-resource-"));
  const workflowRoot = join(fixtureRoot, "assets", "scout", "workflows");
  const targetPath = join(workflowRoot, "missing-resource.json");
  mkdirSync(workflowRoot, { recursive: true });
  const profile = JSON.parse(readFileSync(profilePath, "utf8")) as {
    phases: { workers: Record<string, unknown> };
    roles: Record<string, unknown>;
    resources: Record<string, { default?: true; phases: string[] }>;
  };
  delete profile.resources["common-inspection"]!.default;
  profile.resources["common-inspection"]!.phases = ["Synthesis"];
  profile.phases.workers.unbound = {
    edges: { completed: null, error: null },
  };
  profile.roles["unbound-worker"] = {
    phases: ["unbound"],
    multiAgent: false,
    customAgents: [],
  };
  writeFileSync(targetPath, JSON.stringify(profile), "utf8");

  try {
    const asset = buildWorkflow(fixtureRoot, "missing-resource");
    assert.throws(
      () => new WorkflowBuilder(asset).buildAgentProfile("unbound-worker"),
      /role unbound-worker has no Resource Park for Phase unbound/,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
