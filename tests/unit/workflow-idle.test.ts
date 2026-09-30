import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Workflow, projectWorkflowState } from "../../src/core/workflow/index.js";
import { ScoutBenchmarks } from "../../src/core/benchmarks/index.js";
import { Benchmarks } from "../../src/core/benchmarks/index.js";
import { readJournalEvents } from "../../src/core/journal/index.js";
import { workflowRootFromJournalRoot } from "../../src/core/path.js";
import { RunManifestStore } from "../../src/run/persistence/index.js";
import { projectGraphState } from "../../src/run/resume/projection/index.js";
import { AgentActivityRecorder } from "../../src/agent/telemetry/agent-activity-recorder.js";
import type { ScoutAgent } from "../../src/agent/core/scout-agent.js";
import type { AgentThreadSnapshot } from "../../src/agent/thread/types.js";
import type { RunScope } from "../../src/run/run-scope.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import { SystemEvents } from "../../src/system/events/index.js";
import { createDefaultTestGraph, installTestRunScope, createTestWorkflowAsset } from "../helpers/run-persistence.js";

test("New runtime has no active Workflow until explicitly requested; completed recovery does not create or modify evidence", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-empty-workflow-"));
  const runRoot = join(root, "run", "run-empty");
  const manifestStore = new RunManifestStore(runRoot);
  manifestStore.create({ runId: "run-empty", scoutRoot: root, createdAt: new Date().toISOString(), checkpointSeq: 0 });
  const workflow = new Workflow(createTestWorkflowAsset(createDefaultTestGraph().snapshot()));
  const scope = installTestRunScope(t, { runId: "run-empty", scoutRoot: root, runRoot, workflow, manifestStore });
  const agentRoot = registerCoordinator(scope);
  const entityLog = join(agentRoot, "logs", "activity.log");
  t.after(async () => { await scope.workflow.stop(); rmSync(root, { recursive: true, force: true }); });
  assert.throws(() => workflow.benchmarks, /Benchmarks are unavailable/);
  await workflow.start();
  const sharedBenchmarks = workflow.benchmarks;
  assert.equal(sharedBenchmarks.read("scout"), undefined);
  const recorder = new AgentActivityRecorder();
  recorder.start();
  t.after(() => recorder.stop());
  assert.equal(workflow.snapshot(), undefined);
  assert.deepEqual(workflow.readEvents(), []);
  assert.throws(() => workflow.agentPaths("coordinator"), /Workflow is unavailable/);
  assert.equal(existsSync(join(runRoot, "workflows", "workflow-001")), false);
  await scope.eventBus.publishAndWait(SystemEvents.interaction.userMessageSubmitted, {
    messageId: "history-question", text: "查看历史", attachment: "查看历史", submittedAt: new Date().toISOString(),
  });
  await scope.eventBus.publishAndWait(AgentEvents.activity.observed, {
    agentId: "coordinator", type: "reasoning", status: "completed", detail: "history only",
  });
  assert.match(readFileSync(entityLog, "utf8"), /history only/);
  assert.equal(existsSync(join(agentRoot, "artifacts")), false);
  assert.deepEqual(workflow.readEvents(), []);
  assert.equal(existsSync(join(runRoot, "workflows", "workflow-001")), false);

  await workflow.startWorkflow();
  assert.equal(workflow.benchmarks, sharedBenchmarks);
  assert.equal(workflow.snapshot()?.workflowId, "workflow-001");
  const journalRoot = workflow.journalRoot;
  assert.equal(workflowRootFromJournalRoot(journalRoot), join(runRoot, "workflows", "workflow-001"));
  const journalPath = workflow.journalPath;
  assert.equal(workflow.readEvents().some((event) => event.id === "history-question"), false);
  assert.deepEqual(workflow.agentPaths("coordinator"), {
    artifactRoot: join(runRoot, "workflows", "workflow-001", "agents", "coordinator", "artifacts"),
    logsRoot: join(runRoot, "workflows", "workflow-001", "agents", "coordinator", "logs"),
  });
  await assert.rejects(workflow.startWorkflow(), /already active/);
  await workflow.advance("error");

  assert.equal(workflow.benchmarks, sharedBenchmarks);
  assert.equal(workflow.snapshot(), undefined);
  assert.equal(existsSync(join(runRoot, "workflows", "workflow-002")), false);
  assert.equal(existsSync(join(journalRoot, ".scout.lock")), false);
  assert.equal(existsSync(join(journalRoot, ".base.lock")), false);
  const contents = readFileSync(journalPath, "utf8");
  const benchmarkContents = readFileSync(join(runRoot, "benchmarks.json"), "utf8");
  const events = readJournalEvents(journalPath);
  const resumed = new Workflow(createTestWorkflowAsset(projectGraphState(events)));
  const resumedRecovery = {
    graphState: projectGraphState(events),
    workflowState: projectWorkflowState("workflow-001", events), journalRoot
  };
  await workflow.stop();
  assert.throws(() => workflow.benchmarks, /Benchmarks are unavailable/);
  scope.clearWorkflow(workflow); scope.setWorkflow(resumed);
  await resumed.start();
  resumed.restore(resumedRecovery);
  assert.deepEqual(resumed.benchmarks.read("scout"), sharedBenchmarks.read("scout"));
  assert.equal(resumed.snapshot(), undefined);
  await scope.eventBus.publishAndWait(AgentEvents.activity.observed, {
    agentId: "coordinator", type: "reasoning", status: "completed", detail: "resumed history question",
  });
  const emptyWorkflowLog = readFileSync(entityLog, "utf8");
  assert.match(emptyWorkflowLog, /history only/);
  assert.match(emptyWorkflowLog, /resumed history question/);
  assert.equal(readFileSync(journalPath, "utf8"), contents);
  assert.equal(readFileSync(join(runRoot, "benchmarks.json"), "utf8"), benchmarkContents);
  assert.equal(existsSync(join(runRoot, "workflows", "workflow-002")), false);
});

test("An unfinished renamed Workflow resumes its identity, cursor and current artifact paths", async (t) => {
  const scope = installTestRunScope(t, { runId: "rename-workflow" });
  const recorder = new AgentActivityRecorder();
  recorder.start();
  t.after(() => recorder.stop());
  await scope.eventBus.publishAndWait(AgentEvents.activity.observed, {
    agentId: "researcher", type: "reasoning", status: "completed", detail: "before rename",
  });
  const originalLog = join(scope.workflow.agentPaths("researcher").logsRoot, "activity.log");
  const initial = scope.workflow;
  await initial.advance("completed");
  const workflowState = initial.snapshot()!;
  const graphState = initial.graph.snapshot();
  const benchmarks = new ScoutBenchmarks(new Benchmarks(scope.runRoot));
  const before = readFileSync(benchmarks.path, "utf8");
  for (const domain of scope.domainRegistry.list()) await domain.finishWorkflow?.();
  await initial.stop();
  const renamedRoot = join(scope.runRoot, "workflows", "firebase-fallback v1");
  renameSync(join(scope.runRoot, "workflows", workflowState.workflowId), renamedRoot);
  const selected = benchmarks.resolve("currentWorkflow")!;
  assert.equal(selected.workflowId, workflowState.workflowId);
  assert.equal(selected.workflowRoot, renamedRoot);
  const resumed = new Workflow(createTestWorkflowAsset(graphState));
  const resumedRecovery = {
    graphState,
    workflowState, journalRoot: selected.journalRoot
  };
  scope.clearWorkflow(initial); scope.setWorkflow(resumed);
  await resumed.start();
  resumed.restore(resumedRecovery);
  assert.equal(resumed.snapshot()?.status, "active");
  assert.equal(workflowRootFromJournalRoot(resumed.journalRoot), renamedRoot);
  assert.equal(resumed.graph.snapshot().currentPhase, "research-reviewer");
  assert.equal(resumed.agentPaths("researcher").artifactRoot, join(renamedRoot, "agents", "researcher", "artifacts"));
  await scope.eventBus.publishAndWait(AgentEvents.activity.observed, {
    agentId: "researcher", type: "reasoning", status: "completed", detail: "after renamed resume",
  });
  const renamedLog = readFileSync(join(resumed.agentPaths("researcher").logsRoot, "activity.log"), "utf8");
  assert.match(renamedLog, /before rename/);
  assert.match(renamedLog, /after renamed resume/);
  assert.equal(existsSync(originalLog), false);
  assert.equal(readFileSync(benchmarks.path, "utf8"), before);
  await resumed.stop();
});

test("Agent telemetry keeps idle-runtime activity on the entity without backfilling either Workflow", async (t) => {
  const scope = installTestRunScope(t, { runId: "workflow-telemetry" });
  const entityLog = join(registerCoordinator(scope), "logs", "activity.log");
  const recorder = new AgentActivityRecorder();
  recorder.start();
  t.after(() => recorder.stop());
  const publish = (detail: string) => scope.eventBus.publishAndWait(AgentEvents.activity.observed, {
    agentId: "coordinator", type: "reasoning", status: "completed", detail,
  });
  const firstLog = join(scope.workflow.agentPaths("coordinator").logsRoot, "activity.log");
  await publish("first-workflow-only");
  await scope.workflow.advance("error");

  const oldContents = readFileSync(firstLog, "utf8");
  await publish("empty-workflow-retained");
  const entityContents = readFileSync(entityLog, "utf8");
  assert.match(entityContents, /empty-workflow-retained/);
  assert.doesNotMatch(entityContents, /first-workflow-only/);
  await scope.workflow.startWorkflow();
  const secondLog = join(scope.workflow.agentPaths("coordinator").logsRoot, "activity.log");
  await publish("second-workflow-only");
  assert.notEqual(firstLog, secondLog);
  assert.equal(readFileSync(firstLog, "utf8"), oldContents);
  assert.match(oldContents, /first-workflow-only/);
  const nextContents = readFileSync(secondLog, "utf8");
  assert.match(nextContents, /second-workflow-only/);
  assert.doesNotMatch(nextContents, /empty-workflow-retained|first-workflow-only/);
  assert.equal(readFileSync(entityLog, "utf8"), entityContents);
});

function registerCoordinator(scope: RunScope): string {
  const agentRoot = join(scope.runRoot, "agents", "coordinator");
  const thread: AgentThreadSnapshot = {
    agentId: "coordinator", role: "coordinator", phases: ["Synthesis"], contextBundleId: "cb-telemetry",
    threadId: "thread-coordinator", createdAt: "2026-09-29T00:00:00.000Z", status: "active",
    startInput: {
      cwd: join(agentRoot, "mount"), approvalPolicy: "never", permissions: "scout-coordinator", ephemeral: false,
    },
    startResponse: {},
  };
  scope.agentRegistry.registerAgent({
    agentId: "coordinator",
    get mount() { return { agentRoot }; },
    get threadSnapshot() { return thread; },
    snapshot: () => ({ agentId: "coordinator", thread, pendingMessageCount: 0 }),
  } as ScoutAgent);
  return agentRoot;
}
