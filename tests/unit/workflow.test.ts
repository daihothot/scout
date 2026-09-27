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
  readWorkflowProfile,
} from "../../src/asset-store/index.js";
import { WorkflowBuilder } from "../../src/asset-store/builders/workflow-builder.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import {
  Phase,
  Scheduler,
  WorkflowEvents,
} from "../../src/core/workflow/index.js";
import { AgentTaskDispositionKinds, AgentTaskStatuses, type AgentTaskState } from "../../src/agent/task/types.js";
import { AgentStepStatuses, type AgentStepState } from "../../src/agent/step/types.js";
import { projectGraphState } from "../../src/run/resume/projection/index.js";
import { createTestRunPersistence, installTestRunScope } from "../helpers/run-persistence.js";
import {
  createDomainRuntime,
  DomainAgentBackend,
  ScoutDomainId,
} from "../../src/domain/index.js";
import { RbtDomain, RbtDomainAgentBackend, RbtJournal } from "../../src/domain/domains/rbt/index.js";
import { ValidationDomain } from "../../src/domain/domains/validation/index.js";

const scoutRoot = process.cwd();
const profilePath = join(
  scoutRoot,
  "assets",
  "scout",
  "workflows",
  "rbt.json",
);

test("Domain Runtime is selected by the GraphState domain identifier", async () => {
  const rbt = await createDomainRuntime(ScoutDomainId.Rbt);
  assert.ok(rbt instanceof RbtDomain);
  assert.ok(rbt.backend instanceof DomainAgentBackend);
  assert.equal(typeof rbt.journal.readAll, "function");
  const validation = await createDomainRuntime(ScoutDomainId.Validation);
  assert.ok(validation instanceof ValidationDomain);
  assert.ok(validation.backend instanceof DomainAgentBackend);
  assert.deepEqual(validation.backend.dynamicToolsForPhase("research"), []);
  await assert.rejects(
    createDomainRuntime("missing-domain" as ScoutDomainId),
    /Invalid Workflow domain: missing-domain/,
  );
});

test("Domain loading validates backend methods instead of Domain forwarding methods", async (t) => {
  for (const method of ["register", "unregister", "dynamicToolsForPhase", "handleDynamicToolCall"]) {
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

test("Domain loading validates the Journal read contract", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(RbtJournal.prototype, "readAll");
  Object.defineProperty(RbtJournal.prototype, "readAll", { value: "invalid", configurable: true });
  try {
    await assert.rejects(createDomainRuntime(ScoutDomainId.Rbt), /invalid Domain journal/);
  } finally {
    if (descriptor) Object.defineProperty(RbtJournal.prototype, "readAll", descriptor);
    else Reflect.deleteProperty(RbtJournal.prototype, "readAll");
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

test("Scheduler persists graph initialization and restores the latest Phase", (t) => {
  const eventBus = new InMemoryEventBus();
  const persistence = createTestRunPersistence(
    t,
    "workflow-journal-projection",
    "/repo",
    eventBus,
  );
  const { journal, workflow } = persistence;
  installTestRunScope(t, {
    runId: journal.runId, eventBus, workflow, manifestStore: persistence.manifestStore,
  });

  const advanced = workflow.scheduler.advance("completed");
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
  assert.equal(advanced.state.currentPhase, "research-reviewer");
  assert.equal(projectGraphState(events).currentPhase, "research-reviewer");
});

for (const outcome of ["completed", "error"] as const) {
  for (const status of Object.values(AgentTaskStatuses)) {
    test(`Scheduler ${outcome} checks ${status} Task execution without implicitly releasing it`, (t) => {
      const scope = installTestRunScope(t, { runId: `phase-guard-${outcome}-${status}` });
      const workflow = scope.workflow;
      const now = new Date().toISOString();
      const task: AgentTaskState = {
        type: "local_agent", taskId: "phase-task", taskSequence: 1,
        agentId: "researcher", role: "researcher", phase: "research",
        description: "Outstanding work", initialPrompt: "Do the work", status,
        isBackgrounded: true, stepIds: [], dispositions: [], createdAt: now, updatedAt: now,
      };
      const stored = scope.taskStore.addTask(task);
      const beforeGraph = workflow.graph.snapshot();
      const beforeFlow = workflow.flowSnapshot();
      const beforeJournal = readFileSync(workflow.journalPath, "utf8");
      const benchmarkPath = join(dirname(workflow.journalRoot), "benchmarks.json");
      const beforeBenchmark = readFileSync(benchmarkPath, "utf8");
      let published = 0;
      scope.eventBus.subscribe(WorkflowEvents.workflow.advanced, () => { published += 1; });

      if (status === AgentTaskStatuses.Queued || status === AgentTaskStatuses.Running) {
        assert.throws(() => workflow.scheduler.advance(outcome), /Cannot advance Workflow Phase research: Task phase-task/);
        assert.deepEqual(workflow.graph.snapshot(), beforeGraph);
        assert.deepEqual(workflow.flowSnapshot(), beforeFlow);
        assert.equal(readFileSync(workflow.journalPath, "utf8"), beforeJournal);
        assert.equal(readFileSync(benchmarkPath, "utf8"), beforeBenchmark);
        assert.equal(published, 0);
        assert.deepEqual(scope.taskStore.getTask(task.taskId), stored);
        scope.taskStore.updateTask(task.taskId, (current) => ({ ...current, status: AgentTaskStatuses.Done }));
      }

      const advanced = workflow.scheduler.advance(outcome);
      assert.equal(advanced.cycleCompleted, outcome === "error");
      assert.equal(advanced.state.currentPhase, outcome === "error" ? "research" : "research-reviewer");
      assert.equal(workflow.flowSnapshot().status, outcome === "error" ? "settling" : "active");
      assert.equal(published, 1);
      assert.ok(scope.taskStore.getTask(task.taskId), "Phase advancement does not release the Task");
    });
  }
}

test("Scheduler keeps human-waiting and restored earlier-Phase Tasks on the active Flow", (t) => {
  const scope = installTestRunScope(t, { runId: "phase-guard-human-wait" });
  scope.workflow.scheduler.advance("completed");
  const now = new Date().toISOString();
  scope.taskStore.addTask({
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
  const flow = scope.workflow.flowSnapshot();
  for (const outcome of ["completed", "error"] as const) {
    assert.throws(() => scope.workflow.scheduler.advance(outcome), /restored-human-task \(running\)/);
    assert.deepEqual(scope.workflow.graph.snapshot(), graph);
    assert.deepEqual(scope.workflow.flowSnapshot(), flow);
    assert.doesNotThrow(() => scope.workflow.assertAcceptingInput());
  }
});

for (const status of [AgentTaskStatuses.Done, AgentTaskStatuses.Failed, AgentTaskStatuses.Stopped]) {
  test(`Scheduler waits for a ${status} Task's running Step but not the Coordinator Step`, (t) => {
    const scope = installTestRunScope(t, { runId: `phase-guard-step-${status}` });
    const now = new Date().toISOString();
    scope.taskStore.addTask({
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
    scope.stepStore.restore([
      workerStep,
      { ...workerStep, stepId: "coordinator-step", agentId: "coordinator", taskId: undefined },
    ]);
    const before = scope.workflow.flowSnapshot();
    assert.throws(() => scope.workflow.scheduler.advance("error"), /Worker Step finishing-step for Task ended-task is still running/);
    assert.deepEqual(scope.workflow.flowSnapshot(), before);
    scope.stepStore.updateStep(workerStep.stepId, (step) => ({ ...step, status: AgentStepStatuses.Completed }));
    assert.equal(scope.workflow.scheduler.advance("error").cycleCompleted, true);
    assert.equal(scope.stepStore.getStep("coordinator-step")?.status, AgentStepStatuses.Running);
  });
}

test("GraphState recovery rejects a Run without Workflow initialization", (t) => {
  const { journal } = createTestRunPersistence(t, "workflow-missing-initialization");
  const eventsWithoutWorkflow = journal.readAll().filter((event) =>
    !WorkflowEvents.workflow.initialized.is(event)
  );

  assert.throws(
    () => projectGraphState(eventsWithoutWorkflow),
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
      () => readWorkflowProfile(fixtureRoot, "invalid"),
      /unknown phases field\(s\): entry/,
    );

    const withSuccess = structuredClone(original) as {
      phases: { workers: Record<string, { edges: Record<string, unknown> }> };
    };
    withSuccess.phases.workers.execute!.edges.success = "review";
    writeFileSync(targetPath, JSON.stringify(withSuccess), "utf8");
    assert.throws(
      () => readWorkflowProfile(fixtureRoot, "invalid"),
      /unknown phases\.workers\.execute\.edges field\(s\): success/,
    );

    const withUnknownTarget = structuredClone(original) as {
      phases: { workers: Record<string, { edges: { completed: string } }> };
    };
    withUnknownTarget.phases.workers.execute!.edges.completed = "missing";
    writeFileSync(targetPath, JSON.stringify(withUnknownTarget), "utf8");
    assert.throws(
      () => readWorkflowProfile(fixtureRoot, "invalid"),
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
        () => readWorkflowProfile(fixtureRoot, "invalid"),
        new RegExp(`cannot declare reserved Phase ${reservedPhase}`),
      );
    }

    const coordinatorWithPhase = structuredClone(original) as {
      roles: { coordinator: { phases?: string[] } };
    };
    coordinatorWithPhase.roles.coordinator.phases = ["execute"];
    writeFileSync(targetPath, JSON.stringify(coordinatorWithPhase), "utf8");
    assert.throws(
      () => readWorkflowProfile(fixtureRoot, "invalid"),
      /roles\.coordinator cannot declare phases/,
    );

    const withoutDefaultResource = structuredClone(original) as {
      resources: Record<string, { default?: true; phases: string[] }>;
    };
    delete withoutDefaultResource.resources["common-inspection"]!.default;
    withoutDefaultResource.resources["common-inspection"]!.phases = ["Synthesis"];
    writeFileSync(targetPath, JSON.stringify(withoutDefaultResource), "utf8");
    assert.doesNotThrow(() => readWorkflowProfile(fixtureRoot, "invalid"));

    const withTwoDefaultResources = structuredClone(original) as {
      resources: Record<string, { default?: true }>;
    };
    withTwoDefaultResources.resources["rbt-execution"]!.default = true;
    writeFileSync(targetPath, JSON.stringify(withTwoDefaultResources), "utf8");
    assert.throws(
      () => readWorkflowProfile(fixtureRoot, "invalid"),
      /at most one global default Resource Park; found 2/,
    );

    const withUnknownResourcePhase = structuredClone(original) as {
      resources: Record<string, { phases: string[] }>;
    };
    withUnknownResourcePhase.resources["rbt-execution"]!.phases.push("missing");
    writeFileSync(targetPath, JSON.stringify(withUnknownResourcePhase), "utf8");
    assert.throws(
      () => readWorkflowProfile(fixtureRoot, "invalid"),
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
    const asset = readWorkflowProfile(fixtureRoot, "fallback");
    const agentProfile = new WorkflowBuilder(asset).buildAgentProfile("fallback-worker");
    assert.deepEqual(agentProfile.resourceParks, ["common-inspection"]);
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
    const asset = readWorkflowProfile(fixtureRoot, "missing-resource");
    assert.throws(
      () => new WorkflowBuilder(asset).buildAgentProfile("unbound-worker"),
      /role unbound-worker has no Resource Park for Phase unbound/,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
