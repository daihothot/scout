import { WorkflowState } from "../../src/core/workflow/index.js";
import { RbtDomainProjector } from "../../src/domain/domains/rbt/index.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { AgentEvents } from "../../src/agent/events/index.js";
import type { ScoutEvent } from "../../src/core/events/index.js";
import type { AgentTaskOutcomeSubmission } from "../../src/agent/task/task-events.js";
import { Workflow } from "../../src/core/workflow/index.js";
import { Journal } from "../../src/core/journal/index.js";
import { SystemEvents } from "../../src/system/events/index.js";
import {
  RbtDomain, RbtEvents, type RbtCampaignCommandEvent, type RbtExecutionHistoryReadyEvent,
  type RbtBenchmarkEntry, type RbtCampaignExecutionHistoryFileEvent, type RbtExecutionPackSubmittedEvent,
} from "../../src/domain/domains/rbt/index.js";
import { installTestRunScope, createTestWorkflowAsset } from "../helpers/run-persistence.js";

const bddId = "firebase-fallback";
const targetVersion = "26.9.0";
const now = "2026-09-29T00:00:00.000Z";

async function fixture(t: TestContext) {
  const domain = new RbtDomain();
  const scope = await installTestRunScope(t, { runId: "rbt-benchmarks", scoutRoot: process.cwd(), domain });
  await domain.start();
  const warnings: string[] = [];
  scope.eventBus.subscribe<{ message: string }>(SystemEvents.interaction.disclosureRequested, (event) => { warnings.push(event.payload.message); });
  const entry = (bdd = bddId, version = targetVersion) => scope.workflow.benchmarks.read("rbt", ["bddCatalog", bdd, version]) as RbtBenchmarkEntry | undefined;
  const write = (agentId: string, relative: string, content: string) => {
    const path = join(scope.workflow.agentPaths(agentId).artifactRoot, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  const ref = (agentId: string, path: string) => `scout-artifact://${scope.workflow.snapshot()!.workflowId}/${agentId}/${path}`;
  let submission = 0;
  const handoff = (phase: "execute" | "review", agentId: string, outcome: string): AgentTaskOutcomeSubmission => {
    submission += 1;
    return {
      task: {
        type: "local_agent", taskId: `task-${submission}`, taskSequence: submission, agentId, role: agentId, phase,
        description: "RBT handoff", initialPrompt: "test", status: "done", isBackgrounded: true,
        createdAt: now, updatedAt: now, stepIds: [`step-${submission}`], dispositions: [],
      },
      stepId: `step-${submission}`, outcome, submittedAt: now,
    };
  };
  const submit = async (input: AgentTaskOutcomeSubmission) => {
    await scope.eventBus.publishAndWait(AgentEvents.task.outcomeSubmitted, input);
    // This fixture has no Worker runner; explicitly model its eventual Task release.
    await scope.eventBus.publishAndWait(AgentEvents.task.released, input.task);
  };
  const execute = async (options: { agentId?: string; platform?: string; status?: "completed" | "failed"; version?: string; bdd?: string; sequence?: number } = {}) => {
    const agentId = options.agentId ?? "operator";
    const bdd = options.bdd ?? bddId;
    const version = options.version ?? targetVersion;
    const sequence = options.sequence ?? 1;
    const content = JSON.stringify({ commands: [{ command: "behavior.campaign.start", payload: { campaignId: "campaign", scenarioId: "scenario" } }] });
    write(agentId, `${bdd}/${version}/execute-file.json`, content);
    write(agentId, `${bdd}/${version}/execute-pack/bdd-evidence.md`, "# BDD evidence\n");
    write(agentId, `${bdd}/${version}/execute-pack/evidence/E-CODE-001.md`, "# SDK evidence\n");
    const command: RbtCampaignCommandEvent = {
      bddId: bdd, targetVersion: version, executeFileRef: ref(agentId, `${bdd}/${version}/execute-file.json`),
      executeFileDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      runtimeSequence: sequence, campaignId: "campaign", scenarioId: "scenario", runId: scope.runId,
      sequence: 1, agentId, role: agentId, callId: `call-${sequence}`, platform: { type: options.platform ?? "unity-editor", version: "2022.3" },
      agentInput: {}, request: { type: "behavior.campaign.start", version: 1, correlationId: "start", payload: {} },
      status: "completed", hostCommands: [], startedAt: now, completedAt: now,
    };
    await scope.eventBus.publishAndWait(RbtEvents.campaign.start, command);
    await scope.eventBus.publishAndWait(RbtEvents.campaign.end, {
      ...command, sequence: 2, request: { ...command.request, type: "behavior.campaign.stop" }, status: options.status ?? "completed",
    });
    const history = new RbtDomainProjector().project(domain.recordObject.read()).histories.at(-1)!;
    return { command, history };
  };
  const executionHandoff = (agentId = "operator", bdd = bddId, version = targetVersion) => handoff("execute", agentId, [
    `pack_ref: ${ref(agentId, `${bdd}/${version}/execute-pack`)}`,
    `execute_file_ref: ${ref(agentId, `${bdd}/${version}/execute-file.json`)}`,
  ].join("\n"));
  const review = (history: RbtExecutionHistoryReadyEvent, statuses = ["match"], agentId = "auditor") => {
    const prefix = `${history.bddId}/${history.targetVersion}/review-pack`;
    const value = {
      bddId: history.bddId, targetVersion: history.targetVersion, campaignId: history.campaignId, scenarioId: history.scenarioId,
      executorHistoryRef: history.executorHistoryRef, summary: "Comparison facts, not a manually assigned verdict",
      timeline: statuses.map((status, index) => ({ id: `SR-${index + 1}`, title: "Signal", status, expected: true, actual: true, comparison: "Compared evidence" })),
    };
    const path = write(agentId, `${prefix}/review-result.json`, JSON.stringify(value));
    // Exercise the existing report producer, without introducing another renderer or contract.
    execFileSync(process.execPath, [join(process.cwd(), "assets/scout/skills/domain-rbt-review-pack/scripts/render-review-report.mjs"),
      "--input", path, "--output", join(dirname(path), "review-report.html")]);
    return { input: handoff("review", agentId, `review_result_ref: ${ref(agentId, `${prefix}/review-result.json`)}`), path, value };
  };
  return { domain, scope, warnings, entry, write, ref, submit, handoff, execute, executionHandoff, review };
}

test("RBT indexes actual execution identity and formal Packs; Task done alone is not a Review", async (t) => {
  const f = await fixture(t);
  assert.equal(f.entry(), undefined);
  const { command, history } = await f.execute();
  const entry = f.entry()!;
  assert.deepEqual(entry.history.lastRun, { workflowId: "workflow-001" });
  assert.deepEqual(entry.history.lastExecutionSuccess, { workflowId: "workflow-001" });
  assert.equal(history.platform.type, "unity-editor");
  assert.equal(history.executeFileDigest, command.executeFileDigest);
  assert.equal(history.executorHistoryDigest, `sha256:${createHash("sha256").update(readFileSync(join(f.scope.workflow.agentPaths("operator").artifactRoot, "history/001.json"))).digest("hex")}`);
  assert.equal(f.entry(bddId, "2022.3"), undefined, "platform version is not the SDK key");
  assert.equal(entry.history.lastExecutionPack, undefined);
  assert.equal(entry.statistics, undefined);
  const executionHandoff = f.executionHandoff();
  await f.scope.eventBus.publishAndWait(AgentEvents.task.done, executionHandoff.task);
  assert.equal(f.entry()!.history.lastExecutionPack, undefined);
  await f.submit(executionHandoff);
  assert.deepEqual(f.entry()!.history.lastExecutionPack, { workflowId: "workflow-001" });
  const pack = new RbtDomainProjector().project(f.domain.recordObject.read()).executionPacks.at(-1)!.pack;
  assert.equal(pack.path, `${bddId}/${targetVersion}/execute-pack`);
  assert.equal(pack.executeFile.digest, command.executeFileDigest);
  const digest = execFileSync(process.execPath, [join(process.cwd(), "assets/scout/tools/scout-artifact-digest.cjs"),
    join(f.scope.workflow.agentPaths("operator").artifactRoot, pack.path)], { encoding: "utf8" });
  assert.ok(digest.includes(`digest=${pack.digest}`));
  assert.ok(digest.includes(`digest_algorithm=${pack.algorithm}`));
  const result = f.review(history);
  await f.submit(result.input);
  const reviewed = f.entry()!;
  assert.deepEqual(reviewed.history.lastReviewerPack, { workflowId: "workflow-001" });
  assert.deepEqual(reviewed.history.lastReviewSuccess, { workflowId: "workflow-001" });
  const reviewFact = new RbtDomainProjector().project(f.domain.recordObject.read()).reviews.at(-1)!;
  assert.equal(reviewFact.pack.result, "pass");
  assert.equal(reviewFact.pack.executionPack.agentId, "operator");
  assert.equal(reviewFact.pack.executionPack.digest, pack.digest);
  assert.equal(reviewFact.pack.agentId, "auditor");
  assert.deepEqual(reviewed.statistics?.passedPlatforms, ["unity-editor"]);
  assert.deepEqual(f.warnings, []);
  const facts = new RbtDomainProjector().project(f.domain.recordObject.read());
  assert.equal(facts.executionPacks.length, 1);
  assert.equal(facts.reviews.length, 1);
  assert.equal(f.scope.workflow.readEvents().some((event) => RbtEvents.artifact.reviewSubmitted.is(event)), false);
});

test("Failed execution and non-passing Review retain historical success pointers", async (t) => {
  const f = await fixture(t);
  const successful = await f.execute();
  await f.submit(f.executionHandoff());
  await f.submit(f.review(successful.history).input);
  const success = f.entry()!;
  const failed = await f.execute({ agentId: "failed-operator", platform: "android", status: "failed" });
  await f.submit(f.executionHandoff("failed-operator"));
  assert.deepEqual(f.entry()!.history.lastRun, { workflowId: "workflow-001" });
  assert.equal(failed.history.platform.type, "android");
  assert.deepEqual(f.entry()!.history.lastExecutionSuccess, success.history.lastExecutionSuccess);
  for (const [statuses, expected] of [[ ["warning"], "attention" ], [ ["warning", "not_match"], "fail" ]] as const) {
    const review = f.review(failed.history, [...statuses]);
    await f.submit(review.input);
    assert.equal(new RbtDomainProjector().project(f.domain.recordObject.read()).reviews.at(-1)!.pack.result, expected);
    assert.deepEqual(f.entry()!.history.lastReviewSuccess, success.history.lastReviewSuccess);
    assert.deepEqual(f.entry()!.statistics, success.statistics);
  }
  assert.deepEqual(f.warnings, []);
});

test("RBT reads formal files even when Outcome has no references or contradicts their facts", async (t) => {
  const f = await fixture(t);
  const manualWrite = t.mock.method(f.domain.recordObject, "write", () => { throw new Error("Artifact producers must publish events, not manually record them."); });
  const { history } = await f.execute();
  await f.submit(f.handoff("execute", "operator", ""));
  const reviewed = f.review(history);
  reviewed.input.outcome = "status: failed; platform: android; bdd: invented; version: 99; pack_ref: /not/a/pack";
  await f.submit(reviewed.input);
  assert.deepEqual(f.entry()!.history, {
    lastRun: { workflowId: "workflow-001" }, lastExecutionSuccess: { workflowId: "workflow-001" },
    lastExecutionPack: { workflowId: "workflow-001" }, lastReviewerPack: { workflowId: "workflow-001" },
    lastReviewSuccess: { workflowId: "workflow-001" },
  });
  assert.deepEqual(f.entry()!.statistics?.passedPlatforms, ["unity-editor"]);
  assert.equal(f.entry("invented", "99"), undefined);
  const facts = new RbtDomainProjector().project(f.domain.recordObject.read());
  assert.equal(facts.executionPacks.length, 1);
  assert.equal(facts.reviews.length, 1);
  assert.equal(facts.reviews[0]!.pack.result, "pass");
  assert.equal(manualWrite.mock.callCount(), 0);
  assert.deepEqual(f.warnings, []);
});

test("Each finalized execution publishes one history, including failures and repeated execute-files", async (t) => {
  const f = await fixture(t);
  const notifications: string[] = [];
  const histories: RbtExecutionHistoryReadyEvent[] = [];
  f.scope.eventBus.subscribe<RbtCampaignExecutionHistoryFileEvent>(RbtEvents.history.campaignExecutionHistory, (event) => { notifications.push(event.payload.executorHistoryRef); });
  f.scope.eventBus.subscribe<RbtExecutionHistoryReadyEvent>(RbtEvents.history.ready, (event) => { histories.push(event.payload); });
  for (const sequence of [1, 2, 3]) await f.execute({ sequence, status: sequence === 3 ? "failed" : "completed" });
  assert.equal(notifications.length, 3);
  assert.deepEqual(histories.map((history) => [history.runtimeSequence, history.status]), [[1, "completed"], [2, "completed"], [3, "failed"]]);
  assert.equal(new Set(notifications).size, 3);
  await f.scope.eventBus.publishAndWait(RbtEvents.history.campaignExecutionHistory, histories[2]!);
  assert.equal(histories.length, 3, "repeated file notification must not publish the same execution again");
  assert.equal(new RbtDomainProjector().project(f.domain.recordObject.read()).histories.length, 3);
  assert.deepEqual(f.warnings, []);
});

test("Execution history status, platform and BDD identity are read from the finalized file", async (t) => {
  const f = await fixture(t);
  const content = JSON.stringify({
    runtimeSequence: 1, executeFileRef: f.ref("operator", `${bddId}/${targetVersion}/execute-file.json`),
    executeFileDigest: `sha256:${"a".repeat(64)}`, campaignId: "campaign", scenarioId: "scenario",
    platform: { type: "android", version: "15" }, status: "failed",
  });
  f.write("operator", "history/001.json", content);
  await f.scope.eventBus.publishAndWait(RbtEvents.history.campaignExecutionHistory, {
    agentId: "operator", role: "operator", runtimeSequence: 1, executorHistoryRef: f.ref("operator", "history/001.json"),
    executorHistoryDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    status: "completed", platform: { type: "unity-editor", version: "fake" }, bddId: "invented", targetVersion: "99",
  });
  const history = new RbtDomainProjector().project(f.domain.recordObject.read()).histories[0]!;
  assert.equal(history.status, "failed");
  assert.deepEqual(history.platform, { type: "android", version: "15" });
  assert.equal(history.bddId, bddId);
  assert.equal(history.targetVersion, targetVersion);
  assert.deepEqual(f.entry()!.history.lastRun, { workflowId: "workflow-001" });
  assert.equal(f.entry()!.history.lastExecutionSuccess, undefined);
  assert.equal(f.entry("invented", "99"), undefined);
  assert.deepEqual(f.warnings, []);
});

test("One Agent can submit multiple formal BDD and version files without Outcome path selection", async (t) => {
  const f = await fixture(t);
  const first = await f.execute();
  const second = await f.execute({ version: "26.10.0", sequence: 2 });
  const third = await f.execute({ bdd: "other-bdd", sequence: 3 });
  await f.submit(f.handoff("execute", "operator", "Execution artifacts are ready."));
  const reviews = [first, second, third].map(({ history }) => f.review(history));
  reviews[0]!.input.outcome = "审查完成。";
  await f.submit(reviews[0]!.input);
  for (const [bdd, version] of [[bddId, targetVersion], [bddId, "26.10.0"], ["other-bdd", targetVersion]]) {
    assert.deepEqual(f.entry(bdd, version)!.history.lastReviewSuccess, { workflowId: "workflow-001" });
    assert.deepEqual(f.entry(bdd, version)!.statistics?.passedPlatforms, ["unity-editor"]);
  }
  const facts = new RbtDomainProjector().project(f.domain.recordObject.read());
  assert.equal(facts.executionPacks.length, 3);
  assert.equal(facts.reviews.length, 3);
  await f.submit(reviews[0]!.input);
  assert.equal(new RbtDomainProjector().project(f.domain.recordObject.read()).reviews.length, 3);
  assert.deepEqual(f.warnings, []);
});

test("Subscriber failure does not cause already published Artifact facts to be published again", async (t) => {
  const f = await fixture(t);
  await f.execute();
  await f.execute({ bdd: "other-bdd", sequence: 2 });
  let failOnce = true;
  const dispatch = f.scope.eventBus.subscribe<RbtExecutionPackSubmittedEvent>(RbtEvents.artifact.executionPackSubmitted, (event) => {
    if (event.payload.bddId === "other-bdd" && failOnce) { failOnce = false; throw new Error("subscriber unavailable"); }
  });
  const input = f.handoff("execute", "operator", "Ready");
  await f.submit(input);
  dispatch();
  await f.submit(input);
  const facts = new RbtDomainProjector().project(f.domain.recordObject.read());
  assert.equal(facts.executionPacks.filter((fact) => fact.bddId === bddId).length, 1);
  assert.equal(facts.executionPacks.filter((fact) => fact.bddId === "other-bdd").length, 1);
  assert.equal(f.warnings.length, 1);
});

test("A failed execution in the next Workflow keeps earlier execution and review success pointers", async (t) => {
  const f = await fixture(t);
  const first = await f.execute();
  await f.submit(f.handoff("execute", "operator", ""));
  await f.submit(f.review(first.history).input);
  await f.scope.workflow.advance("error");

  await f.scope.workflow.startWorkflow();
  const second = await f.execute({ platform: "android", status: "failed" });
  await f.submit(f.handoff("execute", "operator", "success"));
  await f.submit(f.review(second.history, ["not_match"]).input);
  const entry = f.entry()!;
  assert.deepEqual(entry.history.lastRun, { workflowId: "workflow-002" });
  assert.deepEqual(entry.history.lastExecutionSuccess, { workflowId: "workflow-001" });
  assert.deepEqual(entry.history.lastExecutionPack, { workflowId: "workflow-002" });
  assert.deepEqual(entry.history.lastReviewerPack, { workflowId: "workflow-002" });
  assert.deepEqual(entry.history.lastReviewSuccess, { workflowId: "workflow-001" });
  assert.deepEqual(entry.statistics?.passedPlatforms, ["unity-editor"]);
  assert.deepEqual(f.warnings, []);
});

for (const corruption of ["recording", "missing-platform", "wrong-reference", "digest-mismatch"] as const) {
  test(`An invalid ${corruption} history notification does not publish a historical fact`, async (t) => {
    const f = await fixture(t);
    const value: Record<string, unknown> = {
      runtimeSequence: 1, executeFileRef: f.ref("operator", `${bddId}/${targetVersion}/execute-file.json`),
      executeFileDigest: `sha256:${"a".repeat(64)}`, campaignId: "campaign", scenarioId: "scenario",
      platform: { type: "unity-editor", version: "2022.3" }, status: "completed",
    };
    if (corruption === "recording") value.status = "recording";
    if (corruption === "missing-platform") value.platform = null;
    if (corruption === "wrong-reference") value.executeFileRef = "scout-artifact://another-workflow/operator/bdd/version/execute-file.json";
    const content = JSON.stringify(value);
    f.write("operator", "history/001.json", content);
    await f.scope.eventBus.publishAndWait(RbtEvents.history.campaignExecutionHistory, {
      agentId: "operator", role: "operator", runtimeSequence: 1, executorHistoryRef: f.ref("operator", "history/001.json"),
      executorHistoryDigest: corruption === "digest-mismatch" ? `sha256:${"b".repeat(64)}` : `sha256:${createHash("sha256").update(content).digest("hex")}`,
    });
    assert.equal(new RbtDomainProjector().project(f.domain.recordObject.read()).histories.length, 0);
    assert.equal(f.entry(), undefined);
    assert.equal(f.warnings.length, 1);
  });
}

test("Passed platforms accumulate across Workflows and deduplicate without mixing SDK versions or BDDs", async (t) => {
  const f = await fixture(t);
  const first = await f.execute();
  await f.submit(f.executionHandoff());
  await f.submit(f.review(first.history).input);
  const firstPack = f.entry()!.history.lastReviewSuccess;
  const oldJournal = f.scope.workflow.journalRoot;
  const oldContents = readFileSync(join(oldJournal, "rbt-events.jsonl"), "utf8");
  await f.scope.workflow.advance("error");

  assert.deepEqual(f.entry()!.history.lastReviewSuccess, firstPack);
  await f.scope.workflow.startWorkflow();
  for (const [agentId, platform] of [["android-first", "android"], ["android-second", "android"], ["editor", "unity-editor"]]) {
    const executed = await f.execute({ agentId, platform });
    await f.submit(f.executionHandoff(agentId));
    await f.submit(f.review(executed.history).input);
  }
  assert.equal(f.entry()!.history.lastReviewSuccess?.workflowId, "workflow-002");
  assert.deepEqual(f.entry()!.statistics?.passedPlatforms, ["unity-editor", "android"]);
  const otherVersion = await f.execute({ agentId: "new-sdk", version: "26.10.0" });
  await f.submit(f.executionHandoff("new-sdk", bddId, "26.10.0"));
  await f.submit(f.review(otherVersion.history).input);
  const otherBdd = await f.execute({ agentId: "another-bdd", bdd: "other-bdd" });
  assert.deepEqual(f.entry("other-bdd")!.history.lastExecutionSuccess, { workflowId: "workflow-002" });
  assert.equal(otherBdd.history.executeFileDigest, otherBdd.command.executeFileDigest);
  assert.equal(f.entry("other-bdd")!.statistics, undefined);
  assert.deepEqual(f.entry(bddId, "26.10.0")!.statistics?.passedPlatforms, ["unity-editor"]);
  assert.deepEqual(f.entry()!.statistics?.passedPlatforms, ["unity-editor", "android"]);
  assert.equal(readFileSync(join(oldJournal, "rbt-events.jsonl"), "utf8"), oldContents);
  assert.deepEqual(f.warnings, []);
});

for (const corruption of ["execute-file", "execute-pack", "history", "bdd", "campaign", "missing-timeline", "unknown-status", "duplicate-point", "invalid-refs", "missing-formal-pack"] as const) {
  test(`Review ${corruption} does not become successful benchmark evidence`, async (t) => {
    const f = await fixture(t);
    const { history } = await f.execute();
    if (corruption !== "missing-formal-pack") await f.submit(f.executionHandoff());
    const review = f.review(history);
    const before = f.scope.workflow.benchmarks.read("rbt");
    switch (corruption) {
      case "execute-file": f.write("operator", `${bddId}/${targetVersion}/execute-file.json`, "changed"); break;
      case "execute-pack": f.write("operator", `${bddId}/${targetVersion}/execute-pack/bdd-evidence.md`, "changed"); break;
      case "history": f.write("operator", "history/001.json", "changed"); break;
      case "bdd": review.value.bddId = "different"; break;
      case "campaign": review.value.campaignId = "different"; break;
      case "missing-timeline": review.value.timeline = []; break;
      case "unknown-status": review.value.timeline[0]!.status = "success"; break;
      case "duplicate-point": review.value.timeline.push(review.value.timeline[0]!); break;
      case "invalid-refs": Object.assign(review.value.timeline[0]!, { refs: { runtime: 1 } }); break;
      case "missing-formal-pack": break;
    }
    writeFileSync(review.path, JSON.stringify(review.value));
    await f.submit(review.input);
    assert.deepEqual(f.scope.workflow.benchmarks.read("rbt"), before);
    assert.equal(new RbtDomainProjector().project(f.domain.recordObject.read()).reviews.length, 0);
    assert.equal(f.warnings.length, 1);
  });
}

test("Benchmark write failure warns without turning a successful execution or handoff into a failure", async (t) => {
  const f = await fixture(t);
  const { history } = await f.execute();
  await f.submit(f.executionHandoff());
  const before = readFileSync(f.scope.workflow.benchmarks.path, "utf8");
  const failed = t.mock.method(f.scope.workflow.benchmarks, "submit", () => { throw new Error("disk full"); });
  await f.submit(f.review(history).input);
  assert.equal(readFileSync(f.scope.workflow.benchmarks.path, "utf8"), before);
  assert.equal(new RbtDomainProjector().project(f.domain.recordObject.read()).reviews.length, 1, "source fact survives index failure");
  assert.match(f.warnings[0]!, /disk full/);
  failed.mock.restore();
  await f.submit(f.review(history).input);
  assert.deepEqual(f.entry()!.statistics?.passedPlatforms, ["unity-editor"]);
});

test("Artifact facts have independent recording and benchmark consumers when the journal fails", async (t) => {
  const f = await fixture(t);
  await f.execute();
  const originalAppend = Journal.prototype.append;
  const failed = t.mock.method(Journal.prototype, "append", function (this: Journal, event: ScoutEvent) {
    if (RbtEvents.artifact.executionPackSubmitted.is(event)) throw new Error("journal unavailable");
    return originalAppend.call(this, event);
  });
  await f.submit(f.executionHandoff());
  assert.deepEqual(f.entry()!.history.lastExecutionPack, { workflowId: "workflow-001" });
  assert.equal(new RbtDomainProjector().project(f.domain.recordObject.read()).executionPacks.length, 0);
  assert.match(f.warnings[0]!, /journal unavailable/);
  failed.mock.restore();
});

test("RBT restore, duplicate handoff and directory rename preserve manually edited benchmark nodes", async (t) => {
  let resumed: Workflow | undefined;
  t.after(() => resumed?.stop());
  const f = await fixture(t);
  const { history } = await f.execute();
  const executor = f.executionHandoff();
  await f.submit(executor);
  const reviewer = f.review(history).input;
  await f.submit(reviewer);
  f.scope.workflow.benchmarks.submit("rbt", [
    { path: ["bddCatalog", bddId, targetVersion, "history", "lastReviewSuccess"], value: { workflowId: "workflow-077", note: "operator selection" } },
    { path: ["bddCatalog", bddId, targetVersion, "statistics", "passedPlatforms"], value: ["ios"] },
  ]);
  const manual = f.scope.workflow.benchmarks.read("rbt");
  const original = f.scope.workflow;
  const state = original.snapshot()!;
  const graphData = original.graph.snapshot();
  const oldRoot = dirname(original.journalRoot);
  await f.domain.stop();
  await original.stop();
  const renamed = join(dirname(oldRoot), "firebase renamed history");
  renameSync(oldRoot, renamed);
  resumed = new Workflow(createTestWorkflowAsset(graphData));
  f.scope.clearWorkflow(original); f.scope.setWorkflow(resumed);
  await resumed.start();
  await resumed.enterState({ state: WorkflowState.Restoring, input: { graphData, workflowData: state, journalRoot: join(renamed, "journal") } });
  await f.domain.start();
  await f.domain.restore(state);
  assert.deepEqual(resumed.benchmarks.read("rbt"), manual);
  assert.equal(resumed.benchmarks.resolve({ workflowId: state.workflowId })?.workflowRoot, renamed);
  await f.submit(executor);
  await f.submit(reviewer);
  assert.deepEqual(resumed.benchmarks.read("rbt"), manual);
  assert.deepEqual(f.warnings, []);
  await f.submit(f.review(history).input);
  assert.deepEqual(f.entry()!.statistics?.passedPlatforms, ["ios", "unity-editor"]);
  assert.equal(f.entry()!.history.lastReviewSuccess?.workflowId, state.workflowId);
  await f.domain.stop();
  const stopped = resumed.benchmarks.read("rbt");
  await f.submit(f.review(history).input);
  assert.deepEqual(resumed.benchmarks.read("rbt"), stopped);
});
