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
import { RbtDomain } from "../../src/domain/rbt/index.js";

const scoutRoot = process.cwd();
const profilePath = join(
  scoutRoot,
  "assets",
  "scout",
  "workflows",
  "rbt.json",
);

test("Domain Runtime is selected by the GraphState domain identifier", async () => {
  assert.ok(await createDomainRuntime("rbt") instanceof RbtDomain);
  await assert.rejects(
    createDomainRuntime("missing-domain"),
    /Cannot load Workflow domain: missing-domain/,
  );
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
