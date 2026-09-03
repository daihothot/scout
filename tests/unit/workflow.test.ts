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
import { join } from "node:path";
import {
  AssetStore,
  readWorkflowProfile,
} from "../../src/asset-store/index.js";
import { WorkflowBuilder } from "../../src/asset-store/builders/workflow-builder.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import {
  Phase,
  Scheduler,
  WorkflowEvents,
} from "../../src/core/workflow/index.js";
import { projectGraphState } from "../../src/run/resume/projection/index.js";
import { createTestRunPersistence } from "../helpers/run-persistence.js";
import { createDomainRuntime } from "../../src/domain/index.js";
import { ValidationDomain } from "../../src/domain/validation/index.js";

const scoutRoot = process.cwd();
const profilePath = join(
  scoutRoot,
  "assets",
  "codex",
  "workflows",
  "validation.json",
);

test("Domain Runtime is selected by the GraphState domain identifier", async () => {
  assert.ok(await createDomainRuntime("validation") instanceof ValidationDomain);
  await assert.rejects(
    createDomainRuntime("missing-domain"),
    /Cannot load Workflow domain: missing-domain/,
  );
});

test("WorkflowBuilder preserves Worker Phase and role declaration order", () => {
  const asset = readWorkflowProfile(scoutRoot, "validation");
  const graph = new AssetStore().buildWorkflow(scoutRoot, "validation");

  assert.equal(asset.name, "validation");
  assert.equal(asset.profile.domain, "validation");
  assert.equal(graph.domain, "validation");
  assert.deepEqual(Object.keys(asset.profile.phases.workers), [
    "research",
    "research-reviewer",
    "verify",
    "verify-reviewer",
  ]);
  assert.deepEqual(Object.keys(asset.profile.resources), [
    "common-inspection",
    "worker-core",
    "repository-access",
    "research-artifacts",
    "artifact-review",
    "runtime-verification",
  ]);
  assert.deepEqual(
    new WorkflowBuilder(asset).buildAgentProfile("coordinator").resourceParks,
    ["common-inspection"],
  );
  assert.deepEqual(
    new WorkflowBuilder(asset).buildAgentProfile("researcher").resourceParks,
    ["common-inspection", "worker-core", "repository-access", "research-artifacts"],
  );
  assert.deepEqual(
    new WorkflowBuilder(asset).buildAgentProfile("validator").resourceParks,
    ["common-inspection", "worker-core", "artifact-review"],
  );
  assert.deepEqual(
    new WorkflowBuilder(asset).buildAgentProfile("verifier").resourceParks,
    ["common-inspection", "worker-core", "repository-access", "runtime-verification"],
  );
  assert.deepEqual(graph.phases.map((phase) => phase.name), [
    "research",
    "research-reviewer",
    "verify",
    "verify-reviewer",
  ]);
  assert.deepEqual(graph.phases.map((phase) => phase.roles), [
    ["researcher"],
    ["validator"],
    ["verifier"],
    ["validator"],
  ]);
  assert.deepEqual(graph.roles.map((role) => role.name), [
    "coordinator",
    "researcher",
    "validator",
    "verifier",
  ]);
  assert.deepEqual(graph.roles[0]?.phases, ["Synthesis"]);
  assert.equal(graph.currentPhase, "research");
  assert.equal(Object.isFrozen(graph), true);
});

test("Scheduler follows completed and error edges without selecting Phase roles", () => {
  const scheduler = new Scheduler(
    new AssetStore().buildWorkflow(scoutRoot, "validation"),
    new InMemoryEventBus(),
  );

  assert.equal(scheduler.advance("completed").state.currentPhase, "research-reviewer");
  assert.equal(scheduler.advance("error").state.currentPhase, "research");
  scheduler.advance("completed");
  scheduler.advance("completed");
  assert.equal(scheduler.snapshot().currentPhase, "verify");
  scheduler.advance("completed");
  assert.equal(scheduler.snapshot().currentPhase, "verify-reviewer");
  const completed = scheduler.advance("completed");
  assert.equal(completed.state.currentPhase, "research");
  assert.equal(completed.cycleCompleted, true);
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
  const { journal, scheduler } = createTestRunPersistence(
    t,
    "workflow-journal-projection",
    "/repo",
    eventBus,
  );

  const advanced = scheduler.advance("completed");
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
  const workflowRoot = join(fixtureRoot, "assets", "codex", "workflows");
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
    withSuccess.phases.workers.research!.edges.success = "research-reviewer";
    writeFileSync(targetPath, JSON.stringify(withSuccess), "utf8");
    assert.throws(
      () => readWorkflowProfile(fixtureRoot, "invalid"),
      /unknown phases\.workers\.research\.edges field\(s\): success/,
    );

    const withUnknownTarget = structuredClone(original) as {
      phases: { workers: Record<string, { edges: { completed: string } }> };
    };
    withUnknownTarget.phases.workers.research!.edges.completed = "missing";
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
    coordinatorWithPhase.roles.coordinator.phases = ["research"];
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
    withTwoDefaultResources.resources["worker-core"]!.default = true;
    writeFileSync(targetPath, JSON.stringify(withTwoDefaultResources), "utf8");
    assert.throws(
      () => readWorkflowProfile(fixtureRoot, "invalid"),
      /at most one global default Resource Park; found 2/,
    );

    const withUnknownResourcePhase = structuredClone(original) as {
      resources: Record<string, { phases: string[] }>;
    };
    withUnknownResourcePhase.resources["worker-core"]!.phases.push("missing");
    writeFileSync(targetPath, JSON.stringify(withUnknownResourcePhase), "utf8");
    assert.throws(
      () => readWorkflowProfile(fixtureRoot, "invalid"),
      /resources\.worker-core references unknown Phase missing/,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("WorkflowBuilder inherits the default Resource Park when its Phase scope allows it", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-workflow-default-resource-"));
  const workflowRoot = join(fixtureRoot, "assets", "codex", "workflows");
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
  const workflowRoot = join(fixtureRoot, "assets", "codex", "workflows");
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
