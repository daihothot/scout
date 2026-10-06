import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentRequestApprovalBackend } from "../../src/agent/backend/request/agent-request-approval-backend.js";
import { agentPermissionRequestSourceType } from "../../src/core/authorization/request-source/permission/agent-permission-request-source.js";
import type { ScoutAgent } from "../../src/agent/core/scout-agent.js";
import type { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";
import type { DynamicToolCallResponse } from "../../src/agent-server/types.js";
import { ShellToolBuilder } from "../../src/asset-store/builders/shell-tool-builder.js";
import type { ShellToolContract } from "../../src/asset-store/contracts/resources.js";
import { RequestSourceEvents } from "../../src/core/authorization/request-source/request-source-events.js";
import { ApprovalEvents } from "../../src/core/authorization/approval/approval-events.js";
import type { BenchmarkValue } from "../../src/core/benchmarks/types.js";
import { authorizationJournalPaths, resolveArtifactTarget, runPaths, workflowAgentPaths, workflowPaths, type ScoutArtifactReference } from "../../src/core/io/index.js";
import { Journal } from "../../src/core/journal/index.js";
import { WorkflowState } from "../../src/core/workflow/state/workflow-state.js";
import { SearchExecutionPackTool } from "../../src/domain/domains/rbt/agent/tools/index.js";
import { RbtDomainAgentBackend } from "../../src/domain/domains/rbt/agent/backend/rbt-domain-agent-backend.js";
import type { ScoutDomainDynamicToolCall } from "../../src/domain/types.js";
import { HostCommandExecutor } from "../../src/host/host-command-executor.js";
import { AuthorizationStage } from "../../src/run/lifecycle/stages/authorization-stage.js";
import { createTestGraph, installTestRunScope } from "../helpers/run-persistence.js";

const bddId = "sample.bdd";
const targetVersion = "26.9.0";
const historicalId = "workflow-009";
const ownerId = "legacy-executor";
const historyAddress = ["bddCatalog", bddId, targetVersion, "history"];
const packReference: ScoutArtifactReference = { workflowId: historicalId, agentId: ownerId, internalSymbols: ["pack"] };
const executeFileReference: ScoutArtifactReference = { ...packReference, internalSymbols: ["pack", "execute-file.json"] };
const successHistory = {
  lastExecutionSuccess: { workflowId: historicalId },
  lastReviewSuccess: { workflowId: historicalId },
  // A newer formal delivery must not replace the jointly successful candidate.
  lastExecutionPack: { workflowId: "workflow-010" },
};

function writePack(artifactRoot: string): string {
  const pack = join(artifactRoot, "pack");
  mkdirSync(join(pack, "evidence"), { recursive: true });
  const templates = join(process.cwd(), "assets/scout/skills/domain-rbt-execution-pack/templates");
  const put = (template: string, target: string, values: Record<string, string>) => {
    const text = readFileSync(join(templates, template), "utf8")
      .replace(/<[^<>\n]+>/g, (token) => values[token] ?? (token === "<human-response>" ? token : "confirmed"))
      .replace(/^- limitations: confirmed$/gm, "- limitations: none");
    writeFileSync(join(pack, target), text);
  };
  put("bdd-evidence.md", "bdd-evidence.md", {
    "<填写唯一 BDD ID 原始值>": bddId,
    "<逐项填写 BDD 明确要求的前置状态；技术值保持原样>": "G-001: configuration is available",
    "<逐项填写 BDD 明确要求的触发动作；command 和技术值保持原样>": "W-001: invoke the getter",
    "<逐项填写 BDD 明确要求的预期行为；技术值保持原样>": "T-001: returns configured value",
  });
  put("source-code-evidence.md", "evidence/E-CODE-001.md", {
    "<填写当前 managed codebase 的版本号>": targetVersion,
    "<填写相对 managed codebase 的源码路径>": "Runtime/Sample.cs",
    "<填写 version:source_relative_file>": `${targetVersion}:Runtime/Sample.cs`,
    "<填写 symbol 起始行号>": "10", "<填写 symbol 结束行号>": "20",
    "<填写支撑 source symbol evidence claim 的关键行号>": "12",
  });
  put("journal-expected.md", "journal-expected.md", {
    "<本次 campaignId 原始值>": "sample/campaign/main", "<本次 scenarioId 原始值>": "sample",
    "<wire kind>": "response_payload", "<Node ID 或 none>": "none",
    "<Variant ID 或 none>": "none", "<Source ID 或 none>": "sample.trigger", "<Capture ID 或 none>": "none",
  });
  const journalPath = join(pack, "journal-expected.md");
  writeFileSync(journalPath, readFileSync(journalPath, "utf8").replace(/^\| 2 \| JR-002.*$/m,
    "| none | JR-002 | behavior_trace | sample.root | none | none | none | SR-002 |"));
  put("signal-expected.md", "signal-expected.md", {
    "<E-BDD-001 中对应的 G-*/W-*/T-* locators>": "E-BDD-001#T-001",
    "<Executor 已保存的 E-CODE-*；仅追溯依据，不要求 Reviewer 回读源码>": "E-CODE-001",
    "<present 或 absent>": "present", "<本次 campaignId>": "sample/campaign/main", "<本次 scenarioId>": "sample",
  });
  const signalPath = join(pack, "signal-expected.md");
  let signal = readFileSync(signalPath, "utf8").replace(/^\| <实际.*$/m,
    "| kind | locate | response_payload | exact |\n| sourceId | locate | sample.trigger | exact |\n| data.value | assert | expected | exact |");
  const rootSignal = signal.match(/## SR-001[\s\S]*?(?=## Rules)/)![0]
    .replace("SR-001", "SR-002").replace("response_payload", "behavior_trace")
    .replace("| sourceId | locate | sample.trigger |", "| id | locate | sample.root |")
    .replace("| data.value | assert | expected |", "| result | assert | success |");
  signal = signal.replace("## Rules", rootSignal + "## Rules");
  writeFileSync(signalPath, signal);
  put("human-input-evidence.md", "human-input-evidence.md", {});
  const humanPath = join(pack, "human-input-evidence.md");
  writeFileSync(humanPath, readFileSync(humanPath, "utf8").replace(/## Human Input Records[\s\S]*?(?=## Evidence Boundary)/,
    "## Human Input Records\n\nnone\n\n"));
  writeFileSync(join(pack, "execute-file.json"), JSON.stringify({ bddId, targetVersion, commands: [
    { command: "behavior.campaign.start", payload: { campaignId: "sample/campaign/main", scenarioId: "sample" } },
    { command: "behavior.scenario.activate", payload: { scenarioId: "sample", rootId: "sample.root", activations: [] } },
    { command: "behavior.trigger.invoke", payload: { scenarioId: "sample", triggerCommandId: "sample.trigger", params: {} } },
    { command: "behavior.scenario.deactivate", payload: { scenarioId: "sample" } },
    { command: "behavior.campaign.stop", payload: { campaignId: "sample/campaign/main" } },
  ] }));
  return pack;
}

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-search-pack-")));
  const stage = new AuthorizationStage();
  t.after(() => stage.stop());
  const scope = await installTestRunScope(t, {
    runId: "search-pack", scoutRoot: root, runRoot: join(root, "run", "search-pack"),
    appServer: { turnSnapshot: () => undefined } as unknown as CodexAppServerClient,
    runtimeGraph: createTestGraph({
      domain: "rbt", workflowProfile: "rbt",
      phases: [
        { name: "execute", roles: ["executor"], edges: { completed: "review", error: null } },
        { name: "review", roles: ["reviewer"], edges: { completed: null, error: "execute" } },
      ],
      roles: [
        { name: "coordinator", phases: ["Synthesis"] },
        { name: "executor", phases: ["execute"] },
        { name: "reviewer", phases: ["review"] },
      ], currentPhase: "execute",
    }),
  });
  await stage.start();
  const checker: ShellToolContract = {
    id: "scoutRbtArtifactCheck", name: "scout-rbt-artifact-check", command: "node",
    args: ["assets/scout/tools/scout-rbt-artifact-check/cli.cjs"], exposeAs: "scout-rbt-artifact-check", required: true,
  };
  const mountRoot = join(root, "mount");
  const built = new ShellToolBuilder(mountRoot, join(process.cwd(), "assets/scout")).build([checker]);
  assert.deepEqual(built.issues, []);
  const wrapper = built.tools[0]!;
  mkdirSync(dirname(wrapper.wrapperPath), { recursive: true });
  writeFileSync(wrapper.wrapperPath, wrapper.wrapperContent, { mode: 0o755 });
  const turns = new Map([["executor", "execute-1"], ["reviewer", "review-1"]]);
  for (const agentId of ["executor", "reviewer"]) {
    scope.agentRegistry.registerAgent({
      agentId, mount: { mountRoot, shellTools: [checker] }, spec: { cwd: root },
      snapshot: () => ({ activeTask: undefined, pendingMessageCount: 0 }),
      assertOwnsActiveTurn(input: { threadId: string; turnId: string }) {
        assert.equal(input.threadId, `thread-${agentId}`);
        assert.equal(input.turnId, turns.get(agentId), "Native Turn is not current");
      },
    } as unknown as ScoutAgent);
    scope.agentRegistry.bindThread(agentId, `thread-${agentId}`);
  }
  const historicalRoot = join(runPaths(scope.runRoot).workflowsRoot, "imported-bdd-evidence");
  const packPath = writePack(workflowAgentPaths(historicalRoot, ownerId).artifactRoot);
  writeFileSync(workflowPaths(historicalRoot).identityPath, JSON.stringify({ workflowId: historicalId }));
  // Imported history retains old identities and need not even be decodable by this Run.
  mkdirSync(workflowPaths(historicalRoot).journalRoot);
  const historicalJournal = join(workflowPaths(historicalRoot).journalRoot, "rbt-events.jsonl");
  writeFileSync(historicalJournal, "original-run: invalid journal with workflow-123 and original-thread\n");
  scope.workflow.benchmarks.submit("rbt", [
    { path: historyAddress, value: successHistory },
    { path: ["bddCatalog", bddId, targetVersion, "statistics"], value: { passedPlatforms: [] } },
  ]);
  const call: ScoutDomainDynamicToolCall = {
    caller: { agentId: "executor", role: "executor", phase: "execute", threadId: "thread-executor" },
    input: { threadId: "thread-executor", turnId: "execute-1", callId: "lookup-1", namespace: "rbt_artifact",
      tool: "SearchExecutionPack", arguments: { bdd_id: bddId, target_version: targetVersion } },
  };
  let registered = 0;
  const unsubscribe = scope.eventBus.subscribe(RequestSourceEvents.authorizationRequestSource.registered, () => { registered += 1; });
  const recordPath = authorizationJournalPaths(scope.workflow.journalRoot).path;
  const recordBytes = () => existsSync(recordPath) ? readFileSync(recordPath, "utf8") : "";
  const approve = async (path: string, agentId: "executor" | "reviewer") => {
    const responses: unknown[] = [];
    await new AgentRequestApprovalBackend().handle({ id: 1, method: "item/permissions/requestApproval", params: {
      threadId: `thread-${agentId}`, turnId: turns.get(agentId), itemId: `item-${agentId}`, cwd: root, environmentId: "local",
      reason: "Read the referenced Pack.",
      permissions: { fileSystem: { entries: [{ path: { type: "path", path }, access: "read" }] } },
    } }, { sendResult: (result) => { responses.push(result); }, sendError: () => assert.fail("Expected permission result") });
    assert.equal(responses.length, 1);
    return responses[0];
  };
  t.after(() => { unsubscribe(); rmSync(root, { recursive: true, force: true }); });
  return { root, scope, stage, call, packPath, historicalRoot, historicalJournal, checker, turns, recordBytes, approve,
    registered: () => registered,
    request: () => scope.authorization.sources(agentPermissionRequestSourceType)[0]!,
    setHistory(history: BenchmarkValue) { scope.workflow.benchmarks.submit("rbt", [{ path: historyAddress, value: history }]); },
  };
}

function output(response: DynamicToolCallResponse) {
  assert.equal(response.success, true);
  const item = response.contentItems[0]!;
  assert.equal(item.type, "inputText");
  if (item.type !== "inputText") assert.fail("Expected text response");
  return JSON.parse(item.text);
}

test("Pack lookup selects the jointly successful Workflow, ignores latest deliveries and statistics, and leaves history untouched", async (t) => {
  const f = await fixture(t);
  const oldJournal = readFileSync(f.historicalJournal, "utf8");
  const benchmarks = readFileSync(f.scope.workflow.benchmarks.path, "utf8");
  const scoutRecords = f.scope.workflow.readEvents();
  const found = output(await new SearchExecutionPackTool().execute(f.call));
  assert.deepEqual(found, {
    status: "found", "execute-pack-ref": packReference,
  });
  const request = f.request();
  assert.equal(request.workflowId, "workflow-001");
  assert.equal(request.maxApprovals, 2);
  assert.deepEqual(request.allowedGrants, [
    { scope: { workflowId: "workflow-001", agentId: "executor", phases: ["execute"], access: "read" },
      target: packReference },
    { scope: { workflowId: "workflow-001", agentId: "reviewer", phases: ["review"], access: "read" },
      target: packReference },
  ]);
  assert.equal(f.registered(), 1);
  assert.deepEqual(f.scope.authorization.approvals(request), [], "Lookup registers a request; it does not approve.");
  assert.deepEqual(f.scope.authorization.credentials(request), []);
  assert.equal(readFileSync(f.historicalJournal, "utf8"), oldJournal);
  assert.equal(readFileSync(f.scope.workflow.benchmarks.path, "utf8"), benchmarks);
  assert.deepEqual(f.scope.workflow.readEvents(), scoutRecords, "No separate lookup-hit record is produced.");
  assert.equal(request.sourceKey, `scout-artifact://${historicalId}/${ownerId}/pack`);
  const resolved = resolveArtifactTarget(found["execute-pack-ref"]);
  assert.deepEqual(resolved, { path: f.packPath });
  assert.deepEqual(await new SearchExecutionPackTool().execute(f.call), { success: true, contentItems: [
    { type: "inputText", text: JSON.stringify(found, null, 2) },
  ] });
  assert.equal(f.registered(), 1, "Repeated search reuses the same registered source.");
});

for (const [name, history, reason] of [
  ["no successful facts", {}, "execution_or_review_not_successful"],
  ["execution completed but review pending", { lastExecutionSuccess: { workflowId: historicalId } }, "execution_or_review_not_successful"],
  ["success facts belong to different Workflows", { ...successHistory, lastReviewSuccess: { workflowId: "workflow-008" } }, "success_workflows_differ"],
] as const) {
  test(`Pack lookup does not reuse when ${name}`, async (t) => {
    const f = await fixture(t);
    f.setHistory(history);
    f.scope.workflow.benchmarks.submit("rbt", [{ path: ["bddCatalog", bddId, targetVersion, "statistics"], value: { passedPlatforms: ["android", "unity-editor"] } }]);
    const run = t.mock.method(HostCommandExecutor.prototype, "run", () => assert.fail("Not eligible for checking"));
    const before = f.recordBytes();
    assert.deepEqual(output(await new SearchExecutionPackTool().execute(f.call)), { status: "not_found", reason });
    assert.equal(run.mock.callCount(), 0);
    assert.equal(f.registered(), 0);
    assert.equal(f.recordBytes(), before);
  });
}

test("Pack lookup resolves renamed and reidentified mounted evidence without historical record edits", async (t) => {
  const f = await fixture(t);
  // An imported Run originally called its first Workflow workflow-001, as this Run does.
  // Its artifact provenance must not redirect a complete mounted Pack into this Run's namesake.
  writePack(f.scope.workflow.agentPaths(ownerId).artifactRoot);
  const historyRoot = join(workflowAgentPaths(f.historicalRoot, ownerId).artifactRoot, "history");
  mkdirSync(historyRoot, { recursive: true });
  const originalHistory = JSON.stringify({ bddId, targetVersion,
    executeFileRef: { ...executeFileReference, workflowId: "workflow-001" } });
  writeFileSync(join(historyRoot, "001.json"), originalHistory);
  const renamed = join(runPaths(f.scope.runRoot).workflowsRoot, "sample-bdd-version-evidence");
  const originalJournal = readFileSync(f.historicalJournal, "utf8");
  renameSync(f.historicalRoot, renamed);
  writeFileSync(workflowPaths(renamed).identityPath, JSON.stringify({ workflowId: "workflow-017" }));
  f.setHistory({ lastExecutionSuccess: { workflowId: "workflow-017" }, lastReviewSuccess: { workflowId: "workflow-017" } });
  const found = output(await new SearchExecutionPackTool().execute(f.call));
  assert.deepEqual(found["execute-pack-ref"], { ...packReference, workflowId: "workflow-017" });
  assert.deepEqual(resolveArtifactTarget(found["execute-pack-ref"]), { path: join(workflowAgentPaths(renamed, ownerId).artifactRoot, "pack") });
  assert.equal(readFileSync(join(workflowPaths(renamed).journalRoot, "rbt-events.jsonl"), "utf8"), originalJournal);
  assert.equal(readFileSync(join(workflowAgentPaths(renamed, ownerId).artifactRoot, "history", "001.json"), "utf8"), originalHistory);
});

test("Pack lookup cannot find absent BDD/SDK data or an unmounted successful Workflow", async (t) => {
  const f = await fixture(t);
  const tool = new SearchExecutionPackTool();
  for (const arguments_ of [
    { bdd_id: "another.bdd", target_version: targetVersion },
    { bdd_id: bddId, target_version: "26.8.0" },
  ]) {
    assert.deepEqual(output(await tool.execute({ ...f.call, input: { ...f.call.input, arguments: arguments_ } })),
      { status: "not_found", reason: "no_successful_workflow" });
  }
  f.setHistory({ lastExecutionSuccess: { workflowId: "workflow-999" }, lastReviewSuccess: { workflowId: "workflow-999" } });
  assert.deepEqual(output(await tool.execute(f.call)), { status: "not_found", reason: "workflow_unavailable" });
  assert.equal(f.registered(), 0);
});

test("Mounted checker rejects malformed Pack contents, wrong SDK evidence and invalid execute-file before registration", async (t) => {
  const f = await fixture(t);
  const tool = new SearchExecutionPackTool();
  for (const [path, content, diagnostic] of [
    [join(f.packPath, "signal-expected.md"), "unfinished pack", "FRONTMATTER"],
    [join(f.packPath, "evidence/E-CODE-001.md"), readFileSync(join(f.packPath, "evidence/E-CODE-001.md"), "utf8").replaceAll(targetVersion, "26.8.0"), "VERSION_MISMATCH"],
    [join(f.packPath, "execute-file.json"), '{"commands":[]}', "EXECUTE_FILE"],
  ]) {
    const original = readFileSync(path!, "utf8");
    writeFileSync(path!, content!);
    const found = output(await tool.execute(f.call));
    assert.equal(found.status, "not_found");
    assert.equal(found.reason, "pack_invalid");
    assert.match(found.detail, new RegExp(diagnostic!));
    writeFileSync(path!, original);
  }
  assert.equal(f.registered(), 0);
  assert.equal(f.recordBytes(), "");
});

test("Pack lookup does not follow symlinked evidence ancestors", async (t) => {
  const f = await fixture(t);
  const artifactRoot = dirname(f.packPath);
  const detached = join(f.root, "detached-artifacts");
  renameSync(artifactRoot, detached);
  symlinkSync(detached, artifactRoot);
  t.mock.method(HostCommandExecutor.prototype, "run", () => assert.fail("Must not read outside evidence ownership"));
  assert.deepEqual(output(await new SearchExecutionPackTool().execute(f.call)), { status: "not_found", reason: "pack_unavailable" });
  assert.equal(f.registered(), 0);
});

test("Pack lookup reports ambiguous artifact ownership instead of guessing which Pack passed", async (t) => {
  const f = await fixture(t);
  cpSync(workflowAgentPaths(f.historicalRoot, ownerId).artifactRoot,
    workflowAgentPaths(f.historicalRoot, "another-executor").artifactRoot, { recursive: true });
  await assert.rejects(new SearchExecutionPackTool().execute(f.call), /Ambiguous RBT Execution Pack/);
  assert.equal(f.registered(), 0);
});

test("Pack lookup reports malformed manual pointers and checker failures rather than successful misses", async (t) => {
  const f = await fixture(t);
  const tool = new SearchExecutionPackTool();
  for (const invalid of [null, "workflow-009", {}]) {
    f.setHistory({ ...successHistory, lastReviewSuccess: invalid });
    await assert.rejects(tool.execute(f.call), /lastReviewSuccess must be a Workflow reference/);
  }
  f.setHistory(successHistory);
  t.mock.method(HostCommandExecutor.prototype, "run", async () => ({
    status: "failed" as const, exitCode: 2, stdout: "", stderr: "checker unavailable", durationMs: 0,
  }));
  await assert.rejects(tool.execute(f.call), /checker unavailable/);
  assert.equal(f.registered(), 0);
});

test("Failed request persistence prevents a usable Pack result", async (t) => {
  const f = await fixture(t);
  t.mock.method(Journal.prototype, "append", () => { throw new Error("request disk unavailable"); });
  await assert.rejects(new SearchExecutionPackTool().execute(f.call), /request disk unavailable/);
  assert.equal(f.recordBytes(), "");
});

test("Search validates Agent arguments and requires an active Workflow without registering misses", async (t) => {
  const f = await fixture(t);
  const tool = new SearchExecutionPackTool();
  for (const arguments_ of [null, [], {}, { bdd_id: " ", target_version: targetVersion },
    { bdd_id: bddId, target_version: 3 }, { bdd_id: bddId, target_version: targetVersion, pack_path: "/outside" }]) {
    await assert.rejects(tool.execute({ ...f.call, input: { ...f.call.input, arguments: arguments_ } }), /SearchExecutionPack/);
  }
  assert.deepEqual(output(await tool.execute({ ...f.call, input: { ...f.call.input, arguments: { bdd_id: "domain/another.bdd", target_version: targetVersion } } })),
    { status: "not_found", reason: "no_successful_workflow" }, "Identities are Benchmark keys, not filesystem components.");
  await f.scope.workflow.enterState({ state: WorkflowState.Idle });
  await assert.rejects(tool.execute(f.call), /Workflow is unavailable/);
  assert.equal(f.registered(), 0);
});

test("Pack lookup registration restores for Reviewer and subsequent credential-backed native Turns", async (t) => {
  const f = await fixture(t);
  const found = output(await new SearchExecutionPackTool().execute(f.call));
  const granted = { permissions: { fileSystem: { entries: [
    { path: { type: "path", path: f.packPath }, access: "read" },
  ] } }, scope: "turn" };
  const sourceId = f.request().sourceId;
  assert.deepEqual(await f.approve(f.packPath, "executor"), granted);
  assert.equal(f.scope.authorization.consumed(f.request()), 1);
  assert.deepEqual(await f.approve(dirname(f.packPath), "executor"), { permissions: {}, scope: "turn" }, "Only the referenced Pack, not its owner's other artifacts, is granted.");
  await f.scope.workflow.advance("completed");
  await f.stage.stop();
  await f.stage.start();
  f.scope.authorization.registerRequestSourceType(agentPermissionRequestSourceType);
  f.scope.authorization.restore(f.scope.workflow.snapshot()!);
  const renamed = join(runPaths(f.scope.runRoot).workflowsRoot, "renamed selected input");
  renameSync(f.historicalRoot, renamed);
  const readPath = join(workflowAgentPaths(renamed, ownerId).artifactRoot, "pack");
  assert.deepEqual(resolveArtifactTarget(found["execute-pack-ref"]), { path: readPath });
  assert.equal(f.request().sourceId, sourceId);
  f.turns.set("reviewer", "review-after-resume");
  const renamedGrant = { permissions: { fileSystem: { entries: [
    { path: { type: "path", path: readPath }, access: "read" },
  ] } }, scope: "turn" };
  assert.deepEqual(await f.approve(f.packPath, "reviewer"), { permissions: {}, scope: "turn" });
  assert.deepEqual(await f.approve(readPath, "reviewer"), renamedGrant);
  const request = f.request();
  assert.equal(f.scope.authorization.consumed(request), 2);
  assert.equal(f.scope.authorization.credentials(request).length, 2);
  f.turns.set("reviewer", "review-next-turn");
  assert.deepEqual(await f.approve(readPath, "reviewer"), renamedGrant);
  assert.equal(f.scope.authorization.consumed(request), 2, "Using the existing credential is not a new approval.");
  assert.equal(f.scope.authorization.credentialUses(f.scope.authorization.credentials(request)[1]!.credentialId).length, 1);
  assert.equal(f.registered(), 1, "Reviewer consumes the original request rather than performing another lookup.");
});

test("Pack file requests approve each consumer once and restore their source grants without rewriting approval facts", async (t) => {
  const f = await fixture(t);
  await new SearchExecutionPackTool().execute(f.call);
  const source = f.request();
  assert.equal(source.maxApprovals, 2);
  const readFile = (path: string) => ({ permissions: { fileSystem: { entries: [
    { path: { type: "path", path }, access: "read" },
  ] } }, scope: "turn" });
  const executePath = join(f.packPath, "execute-file.json");
  assert.deepEqual(await f.approve(executePath, "executor"), readFile(executePath));
  assert.equal(f.scope.authorization.consumed(source), 1);
  assert.deepEqual(f.scope.authorization.credentials(source)[0]!.target, packReference);
  const journalPath = join(f.packPath, "journal-expected.md");
  assert.deepEqual(await f.approve(journalPath, "executor"), readFile(journalPath));
  assert.equal(f.scope.authorization.consumed(source), 1);

  await f.scope.workflow.advance("completed");
  // Stored decisions can identify a contained file. The source contract determines
  // the complete reusable runtime grant; replay never edits the original fact.
  const approvalId = randomUUID();
  const submittedAt = new Date().toISOString();
  await f.scope.eventBus.publishAndWait(ApprovalEvents.authorizationApproval.submitted, {
    approvalId, sourceId: source.sourceId, sourceType: source.type, workflowId: source.workflowId, submittedAt,
    consumer: { agentId: "reviewer", phase: "review" },
    result: { decision: "approved", scope: source.allowedGrants[1]!.scope,
      target: { ...packReference, internalSymbols: ["pack", "journal-expected.md"] } },
    basis: { kind: "new" },
  }, { id: approvalId, occurredAt: submittedAt });
  const originalRecords = f.recordBytes();
  await f.stage.stop();
  await f.stage.start();
  f.scope.authorization.registerRequestSourceType(agentPermissionRequestSourceType);
  f.scope.authorization.restore(f.scope.workflow.snapshot()!);
  assert.equal(f.recordBytes(), originalRecords, "Projection does not rewrite persisted approvals.");
  const restored = f.request();
  assert.equal(restored.sourceId, source.sourceId);
  assert.equal(f.scope.authorization.consumed(restored), 2);
  const credentials = f.scope.authorization.credentials(restored);
  assert.equal(credentials.length, 2);
  assert.deepEqual(credentials.map(({ target }) => target), [packReference, packReference]);
  const reviewerCredential = credentials.find(({ scope }) => scope.agentId === "reviewer")!;
  assert.equal(reviewerCredential.credentialId, approvalId);
  f.turns.set("reviewer", "review-after-resume");
  for (const file of ["journal-expected.md", "signal-expected.md", "execute-file.json"]) {
    const path = join(f.packPath, file);
    assert.deepEqual(await f.approve(path, "reviewer"), readFile(path));
  }
  assert.deepEqual(await f.approve(f.packPath, "reviewer"), readFile(f.packPath));
  assert.equal(f.scope.authorization.consumed(restored), 2);
  assert.equal(f.scope.authorization.approvals(restored).length, 2);
  assert.equal(f.scope.authorization.credentialUses(approvalId).length, 4);
  assert.equal(f.recordBytes().startsWith(originalRecords), true, "Further grants append only credential-use facts.");
  assert.deepEqual(await f.approve(dirname(f.packPath), "reviewer"), { permissions: {}, scope: "turn" });
  assert.equal(f.scope.authorization.consumed(restored), 2);
  assert.equal(f.registered(), 1);
});

test("RBT Backend invokes the constructed lookup tool", async (t) => {
  const f = await fixture(t);
  const backend = new RbtDomainAgentBackend({ execute: () => ({ success: true, contentItems: [] }) }, new SearchExecutionPackTool());
  const result = await backend.handleDynamicToolCall(f.call);
  assert.ok(result);
  assert.equal(output(result).status, "found");
  const invalid = await backend.handleDynamicToolCall({ ...f.call, input: { ...f.call.input, arguments: { bdd_id: "", target_version: targetVersion } } });
  assert.ok(invalid);
  assert.equal(invalid.success, false);
  assert.equal(f.registered(), 1);
});

test("Successful Workflow evidence locates its actual input Pack owned by another Workflow", async (t) => {
  const f = await fixture(t);
  const successfulId = "workflow-010";
  const successfulRoot = join(runPaths(f.scope.runRoot).workflowsRoot, "successful execution with existing input");
  const historyRoot = join(workflowAgentPaths(successfulRoot, "executor").artifactRoot, "history");
  mkdirSync(historyRoot, { recursive: true });
  writeFileSync(workflowPaths(successfulRoot).identityPath, JSON.stringify({ workflowId: successfulId }));
  const executeFileRef = executeFileReference;
  writeFileSync(join(historyRoot, "001.json"), JSON.stringify({ bddId, targetVersion, executeFileRef }));
  f.setHistory({ lastExecutionSuccess: { workflowId: successfulId }, lastReviewSuccess: { workflowId: successfulId } });
  const original = readFileSync(join(f.packPath, "execute-file.json"), "utf8");
  const found = output(await new SearchExecutionPackTool().execute(f.call));
  assert.deepEqual(found["execute-pack-ref"], packReference);
  assert.deepEqual(resolveArtifactTarget(found["execute-pack-ref"]), { path: f.packPath });
  const request = f.request();
  assert.equal(request.allowedGrants[0]!.target.workflowId, historicalId);
  assert.equal(readFileSync(join(f.packPath, "execute-file.json"), "utf8"), original);
});

test("Review delivery selects the actual external Pack instead of a retained local trial Pack", async (t) => {
  const f = await fixture(t);
  const successfulId = "workflow-010";
  const successfulRoot = join(runPaths(f.scope.runRoot).workflowsRoot, "execution after a local trial");
  const artifacts = workflowAgentPaths(successfulRoot, "executor").artifactRoot;
  const localPack = writePack(artifacts);
  const localRef = { workflowId: successfulId, agentId: "executor", internalSymbols: ["pack", "execute-file.json"] };
  mkdirSync(join(artifacts, "history"));
  for (const [sequence, executeFileRef] of [["001", localRef], ["002", executeFileReference]] as const) {
    writeFileSync(join(artifacts, "history", `${sequence}.json`), JSON.stringify({ bddId, targetVersion, executeFileRef }));
  }
  const reviewRoot = join(workflowAgentPaths(successfulRoot, "reviewer").artifactRoot, "pack");
  mkdirSync(reviewRoot, { recursive: true });
  writeFileSync(join(reviewRoot, "review-result.json"), JSON.stringify({
    executorHistoryRef: { workflowId: successfulId, agentId: "executor", internalSymbols: ["history", "002.json"] },
  }));
  writeFileSync(workflowPaths(successfulRoot).identityPath, JSON.stringify({ workflowId: successfulId }));
  f.setHistory({ lastExecutionSuccess: { workflowId: successfulId }, lastReviewSuccess: { workflowId: successfulId } });
  const found = output(await new SearchExecutionPackTool().execute(f.call));
  assert.deepEqual(found["execute-pack-ref"], packReference);
  assert.notEqual(f.packPath, localPack);
  assert.deepEqual(resolveArtifactTarget(found["execute-pack-ref"]), { path: f.packPath });
});

test("A mounted Review's local Pack link follows its new identity rather than the original Run's namesake", async (t) => {
  const f = await fixture(t);
  writePack(f.scope.workflow.agentPaths(ownerId).artifactRoot);
  const artifacts = workflowAgentPaths(f.historicalRoot, ownerId).artifactRoot;
  mkdirSync(join(artifacts, "history"));
  writeFileSync(join(artifacts, "history", "001.json"), JSON.stringify({ bddId, targetVersion,
    executeFileRef: { ...executeFileReference, workflowId: "workflow-001" } }));
  const reviewRoot = join(workflowAgentPaths(f.historicalRoot, "old-reviewer").artifactRoot, "pack");
  mkdirSync(reviewRoot, { recursive: true });
  writeFileSync(join(reviewRoot, "review-result.json"), JSON.stringify({
    executorHistoryRef: { workflowId: "workflow-001", agentId: ownerId, internalSymbols: ["history", "001.json"] },
  }));
  const found = output(await new SearchExecutionPackTool().execute(f.call));
  assert.deepEqual(found["execute-pack-ref"], packReference);
  assert.deepEqual(resolveArtifactTarget(found["execute-pack-ref"]), { path: f.packPath });
});

test("Pack lookup resolves replaced trial inputs through Review delivery, including duplicate links and renamed mounts", async (t) => {
  const f = await fixture(t);
  const successfulId = "workflow-010";
  const successfulRoot = join(runPaths(f.scope.runRoot).workflowsRoot, "retried execution");
  const historyRoot = join(workflowAgentPaths(successfulRoot, "executor").artifactRoot, "history");
  mkdirSync(historyRoot, { recursive: true });
  writeFileSync(workflowPaths(successfulRoot).identityPath, JSON.stringify({ workflowId: successfulId }));
  const replacedRef = executeFileReference;
  const deliveredPack = writePack(workflowAgentPaths(f.historicalRoot, "replacement-executor").artifactRoot);
  const deliveredRef = { ...executeFileReference, agentId: "replacement-executor" };
  for (const [sequence, executeFileRef, status] of [
    ["001", replacedRef, "failed"], ["002", deliveredRef, "completed"], ["003", replacedRef, "failed"],
  ]) {
    writeFileSync(join(historyRoot, `${sequence}.json`), JSON.stringify({ bddId, targetVersion, executeFileRef, status }));
  }
  const review = JSON.stringify({ executorHistoryRef: { workflowId: successfulId, agentId: "executor", internalSymbols: ["history", "002.json"] },
    result: "attention" }); // Eligibility is determined by Benchmarks, not re-evaluated from Review fields.
  for (const reviewer of ["reviewer", "second-reviewer"]) {
    const reviewRoot = join(workflowAgentPaths(successfulRoot, reviewer).artifactRoot, "pack");
    mkdirSync(reviewRoot, { recursive: true });
    writeFileSync(join(reviewRoot, "review-result.json"), review);
  }
  f.setHistory({ lastExecutionSuccess: { workflowId: successfulId }, lastReviewSuccess: { workflowId: successfulId } });
  const benchmarks = readFileSync(f.scope.workflow.benchmarks.path, "utf8");
  const tool = new SearchExecutionPackTool();
  const found = output(await tool.execute(f.call));
  assert.deepEqual(found["execute-pack-ref"], { ...packReference, agentId: "replacement-executor" });
  assert.deepEqual(resolveArtifactTarget(found["execute-pack-ref"]), { path: deliveredPack });
  assert.equal(readFileSync(f.scope.workflow.benchmarks.path, "utf8"), benchmarks);

  const renamed = join(runPaths(f.scope.runRoot).workflowsRoot, "renamed retried evidence");
  renameSync(successfulRoot, renamed);
  // Mounted Workflow identities can change without rewriting their original delivery links.
  writeFileSync(workflowPaths(renamed).identityPath, JSON.stringify({ workflowId: "workflow-017" }));
  f.setHistory({ lastExecutionSuccess: { workflowId: "workflow-017" }, lastReviewSuccess: { workflowId: "workflow-017" } });
  const mounted = output(await tool.execute(f.call));
  assert.deepEqual(mounted["execute-pack-ref"], found["execute-pack-ref"]);
  assert.deepEqual(resolveArtifactTarget(mounted["execute-pack-ref"]), { path: deliveredPack });
  assert.equal(readFileSync(join(workflowAgentPaths(renamed, "reviewer").artifactRoot,
    "pack", "review-result.json"), "utf8"), review);
});

test("Distinct Review deliveries remain genuinely ambiguous rather than choosing by status or sequence", async (t) => {
  const f = await fixture(t);
  const successfulRoot = join(runPaths(f.scope.runRoot).workflowsRoot, "conflicting deliveries");
  const historyRoot = join(workflowAgentPaths(successfulRoot, "executor").artifactRoot, "history");
  mkdirSync(historyRoot, { recursive: true });
  writeFileSync(workflowPaths(successfulRoot).identityPath, JSON.stringify({ workflowId: "workflow-010" }));
  writePack(workflowAgentPaths(f.historicalRoot, "another-executor").artifactRoot);
  for (const [sequence, owner, reviewer, result] of [
    ["001", ownerId, "reviewer", "fail"], ["002", "another-executor", "second-reviewer", "pass"],
  ]) {
    writeFileSync(join(historyRoot, `${sequence}.json`), JSON.stringify({ bddId, targetVersion,
      executeFileRef: { ...executeFileReference, agentId: owner } }));
    const reviewRoot = join(workflowAgentPaths(successfulRoot, reviewer!).artifactRoot, "pack");
    mkdirSync(reviewRoot, { recursive: true });
    writeFileSync(join(reviewRoot, "review-result.json"), JSON.stringify({ result,
      executorHistoryRef: { workflowId: "workflow-010", agentId: "executor", internalSymbols: ["history", `${sequence}.json`] } }));
  }
  f.setHistory({ lastExecutionSuccess: { workflowId: "workflow-010" }, lastReviewSuccess: { workflowId: "workflow-010" } });
  await assert.rejects(new SearchExecutionPackTool().execute(f.call), /Ambiguous RBT Execution Pack/);
  assert.equal(f.registered(), 0);
});
