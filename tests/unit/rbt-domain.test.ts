import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentEvents } from "../../src/agent/events/index.js";
import type { AgentCommandExecutionObservedEvent } from "../../src/agent/command-execution/command-execution-events.js";
import type { ScoutAgent } from "../../src/agent/core/scout-agent.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { createGraphState, Scheduler } from "../../src/core/workflow/index.js";
import { RbtDomain, RbtEvents } from "../../src/domain/rbt/index.js";
import type { ShellToolContract } from "../../src/asset-store/contracts/resources.js";
import type { RunEnvironment } from "../../src/run/types.js";
import { installTestRunScope } from "../helpers/run-persistence.js";
import { Result } from "../../src/core/result.js";

test("RBT Domain records one readable campaign artifact and notifies Coordinator", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = new RbtDomain();
  const scheduler = rbtScheduler(eventBus);
  const scope = installTestRunScope(t, {
    runId: "run-rbt-campaign",
    eventBus,
    domain,
    scheduler,
  });
  const artifactRoot = join(scope.runRoot, "agents", "executor", "artifacts");
  scope.setEnvironment(rbtEnvironment(scope.runId, artifactRoot));
  const messages: Array<{ message: string; messageId?: string }> = [];
  scope.agentRegistry.registerAgent({
    agentId: "coordinator",
    role: "coordinator",
    sendMessage: async (input: { message: string; delivery?: { messageId: string } }) => {
      messages.push({ message: input.message, messageId: input.delivery?.messageId });
      return Result.ok(undefined);
    },
  } as unknown as ScoutAgent);
  await domain.start();
  t.after(() => domain.stop());

  await publishCommand(eventBus, 1, campaignCommand(
    "behavior.campaign.start",
    { campaignId: "campaign-001", scenarioId: "scenario-001" },
    { campaignId: "campaign-001", status: "running" },
  ));
  await publishCommand(eventBus, 2, campaignCommand(
    "behavior.node.variants",
    { id: "node-001" },
    { id: "node-001", variants: [] },
  ));
  await publishCommand(eventBus, 3, campaignCommand(
    "behavior.campaign.stop",
    { campaignId: "campaign-001" },
    { campaignId: "campaign-001", status: "stopped" },
  ));

  const artifactPath = join(artifactRoot, "campaigns", "campaign-001.md");
  const text = readFileSync(artifactPath, "utf8");
  assert.match(text, /^# RBT Campaign 记录：campaign-001$/m);
  assert.match(text, /本文档由 Scout Runtime 按实际命令观察结果生成/);
  assert.match(text, /status: finalized/);
  assert.match(text, /### 1\. behavior\.campaign\.start/);
  assert.match(text, /### 2\. behavior\.node\.variants/);
  assert.match(text, /### 3\. behavior\.campaign\.stop/);
  assert.match(text, /```json\n\{\n  "type": "behavior\.campaign\.start"/);
  assert.match(text, /#### 返回值\n\n```json\n\{/);
  assert.equal(messages.length, 1);
  assert.match(messages[0]?.message ?? "", /runtime_campaign_identity: campaign-001/);
  assert.match(messages[0]?.message ?? "", /runtime_campaign_artifact_ref: agents\/executor\/artifacts\/campaigns\/campaign-001\.md/);

  const published = scope.journal.readAll().find((event) =>
    RbtEvents.campaign.artifactPublished.is(event)
  );
  assert.ok(published && RbtEvents.campaign.artifactPublished.is(published));
  assert.equal(published.payload.campaignId, "campaign-001");
  assert.equal(published.payload.commandCount, 3);
  assert.equal(published.payload.status, "finalized");
});

test("RBT Domain restores finalized and active campaign recordings from Journal", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = new RbtDomain();
  const scheduler = rbtScheduler(eventBus);
  const scope = installTestRunScope(t, {
    runId: "run-rbt-restore",
    eventBus,
    domain,
    scheduler,
  });
  const artifactRoot = join(scope.runRoot, "agents", "executor", "artifacts");
  scope.setEnvironment(rbtEnvironment(scope.runId, artifactRoot));
  await domain.start();

  await publishCommand(eventBus, 1, campaignCommand(
    "behavior.campaign.start",
    { campaignId: "campaign-final" },
    { campaignId: "campaign-final", status: "running" },
  ));
  await publishCommand(eventBus, 2, campaignCommand(
    "behavior.campaign.stop",
    { campaignId: "campaign-final" },
    { campaignId: "campaign-final", status: "stopped" },
  ));
  await publishCommand(eventBus, 3, campaignCommand(
    "behavior.campaign.start",
    { campaignId: "campaign-active" },
    { campaignId: "campaign-active", status: "running" },
  ));
  await domain.stop();

  const restored = new RbtDomain();
  await restored.restore();
  const finalText = readFileSync(
    join(artifactRoot, "campaigns", "campaign-final.md"),
    "utf8",
  );
  const activeText = readFileSync(
    join(artifactRoot, "campaigns", "campaign-active.md"),
    "utf8",
  );
  assert.match(finalText, /status: finalized/);
  assert.match(finalText, /command_count: 2/);
  assert.match(activeText, /status: recording/);
  assert.match(activeText, /command_count: 1/);
});

test("RBT Domain parses variables and multiple Jarvis calls in one shell command", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = new RbtDomain();
  const scope = installTestRunScope(t, {
    runId: "run-rbt-compound-command",
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
  });
  const artifactRoot = join(scope.runRoot, "agents", "executor", "artifacts");
  scope.setEnvironment(rbtEnvironment(scope.runId, artifactRoot));
  await domain.start();
  t.after(() => domain.stop());

  const startResult = behaviorResult(
    "behavior.campaign.start",
    { campaignId: "scenario-001/campaign/main", status: "running" },
  );
  const stopResult = behaviorResult(
    "behavior.campaign.stop",
    { campaignId: "scenario-001/campaign/main", status: "stopped" },
  );
  await publishObserved(eventBus, 1, {
    command: [
      "scenario_id=\"scenario-001\"; campaign_id=\"$scenario_id/campaign/main\";",
      "jarvis ws schema call behavior-control --params-json",
      "'{\"type\":\"behavior.campaign.start\",\"version\":1,\"payload\":{\"campaignId\":\"'\"$campaign_id\"'\"}}'",
      "&& jarvis ws schema call behavior-control --params-json",
      "'{\"type\":\"behavior.campaign.stop\",\"version\":1,\"payload\":{\"campaignId\":\"'\"$campaign_id\"'\"}}'",
    ].join(" "),
    aggregatedOutput: `[RESULT] ${JSON.stringify(startResult)}\n[RESULT] ${JSON.stringify(stopResult)}\n`,
  });

  const text = readFileSync(
    join(artifactRoot, "campaigns", "scenario-001%2Fcampaign%2Fmain.md"),
    "utf8",
  );
  assert.match(text, /status: finalized/);
  assert.match(text, /command_count: 2/);
  assert.match(text, /### 1\. behavior\.campaign\.start/);
  assert.match(text, /### 2\. behavior\.campaign\.stop/);
  assert.match(text, /scenario-001\/campaign\/main/);
});

test("RBT Domain does not finalize a failed campaign stop", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = new RbtDomain();
  const scope = installTestRunScope(t, {
    runId: "run-rbt-failed-stop",
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
  });
  const artifactRoot = join(scope.runRoot, "agents", "executor", "artifacts");
  scope.setEnvironment(rbtEnvironment(scope.runId, artifactRoot));
  await domain.start();
  t.after(() => domain.stop());

  await publishObserved(eventBus, 1, campaignCommand(
    "behavior.campaign.start",
    { campaignId: "campaign-failed-stop" },
    { campaignId: "campaign-failed-stop", status: "running" },
  ));
  await publishObserved(eventBus, 2, {
    command: campaignCommand(
      "behavior.campaign.stop",
      { campaignId: "campaign-failed-stop" },
      { campaignId: "campaign-failed-stop", status: "error" },
    ).command,
    aggregatedOutput: `[RESULT] ${JSON.stringify({
      type: "behavior.command.result",
      version: 1,
      status: "error",
      ok: false,
    })}\n`,
    status: "failed",
    exitCode: 1,
  });

  const text = readFileSync(
    join(artifactRoot, "campaigns", "campaign-failed-stop.md"),
    "utf8",
  );
  assert.match(text, /status: recording/);
  assert.doesNotMatch(text, /status: finalized/);
  assert.equal(
    scope.journal.readAll().some((event) => RbtEvents.campaign.artifactPublished.is(event)),
    false,
  );
});

test("RBT Domain executes Unity Pipeline operations for the execute role", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = new RbtDomain();
  const scope = installTestRunScope(t, {
    runId: "run-rbt-unity-pipeline",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
  });
  const artifactRoot = join(scope.runRoot, "agents", "executor", "artifacts");
  scope.setEnvironment(rbtEnvironment(scope.runId, artifactRoot, [{
    id: "unity",
    name: "unity",
    command: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--"],
    exposeAs: "unity",
    required: true,
  }]));

  const [tool] = domain.dynamicToolsForRole("executor");
  assert.ok(tool);
  assert.equal(domain.dynamicToolsForRole("coordinator").length, 0);
  assert.equal(domain.dynamicToolsForRole("reviewer").length, 0);
  const response = await domain.handleDynamicToolCall({
    input: {
      threadId: "thread-executor",
      turnId: "turn-executor",
      callId: "call-unity-status",
      namespace: tool.namespace ?? null,
      tool: tool.name,
      arguments: { operation: "status" },
    },
    caller: {
      agentId: "executor",
      role: "executor",
      threadId: "thread-executor",
    },
  });

  assert.ok(response);
  assert.equal(response.success, true);
  const result = JSON.parse(response.contentItems[0]?.text ?? "null") as {
    operation: string;
    status: string;
    exitCode: number;
    stdout: string;
  };
  assert.equal(result.operation, "status");
  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), ["--json", "--non-interactive", "status"]);
});

test("RBT Domain rejects Unity Pipeline calls from non-execute roles", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = new RbtDomain();
  const scope = installTestRunScope(t, {
    runId: "run-rbt-unity-pipeline-role",
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
  });
  scope.setEnvironment(rbtEnvironment(
    scope.runId,
    join(scope.runRoot, "agents", "executor", "artifacts"),
  ));

  const response = await domain.handleDynamicToolCall({
    input: {
      threadId: "thread-coordinator",
      turnId: "turn-coordinator",
      callId: "call-unity-status",
      namespace: "rbt_unity_pipeline",
      tool: "UnityPipeline",
      arguments: { operation: "status" },
    },
    caller: {
      agentId: "coordinator",
      role: "coordinator",
      threadId: "thread-coordinator",
    },
  });

  assert.ok(response);
  assert.equal(response.success, false);
  assert.match(response.contentItems[0]?.text ?? "", /only available to an RBT execute role/);
});

function rbtScheduler(eventBus: InMemoryEventBus): Scheduler {
  return new Scheduler(createGraphState({
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
  }), eventBus);
}

function rbtEnvironment(
  runId: string,
  artifactRoot: string,
  shellTools: ShellToolContract[] = [],
): RunEnvironment {
  return {
    agents: {
      executor: {
        role: "executor",
        mount: { artifactRoot, shellTools },
      },
    },
    rootAccess: { mountRoots: [], readableRoots: [], writableRoots: [] },
    contextBundle: {
      contextBundleId: `context-${runId}`,
      runId,
      assetCommit: {},
      sharedInputs: { mountRoot: "/mount", manifestPath: "/mount/manifest.json", resourceHash: "rbt" },
    },
  } as unknown as RunEnvironment;
}

function campaignCommand(
  type: string,
  payload: Record<string, unknown>,
  resultPayload: Record<string, unknown>,
): Pick<AgentCommandExecutionObservedEvent, "command" | "aggregatedOutput"> {
  const correlationId = `correlation-${type}`;
  const request = JSON.stringify({ type, version: 1, correlationId, payload });
  const result = JSON.stringify({
    type: "behavior.command.result",
    version: 1,
    correlationId,
    status: "ok",
    code: "ok",
    payload: resultPayload,
  });
  return {
    command: `jarvis ws schema call behavior-control --session rbt --params-json '${request}' --timeout-ms 10000`,
    aggregatedOutput: `[RESULT] ${result}\n`,
  };
}

function behaviorResult(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "behavior.command.result",
    version: 1,
    status: "ok",
    code: "ok",
    payload,
  };
}

async function publishCommand(
  eventBus: InMemoryEventBus,
  sourceSeq: number,
  command: Pick<AgentCommandExecutionObservedEvent, "command" | "aggregatedOutput">,
): Promise<void> {
  const observedAt = `2026-09-05T00:00:0${sourceSeq}.000Z`;
  await eventBus.publishAndWait(AgentEvents.commandExecution.observed, {
    sourceSeq,
    agentId: "executor",
    role: "executor",
    taskId: "task-execute-001",
    threadId: "thread-executor",
    turnId: "turn-executor",
    itemId: `command-${sourceSeq}`,
    command: command.command,
    status: "completed",
    exitCode: 0,
    aggregatedOutput: command.aggregatedOutput,
    durationMs: 10,
    observedAt,
  } satisfies AgentCommandExecutionObservedEvent, { occurredAt: observedAt });
}

async function publishObserved(
  eventBus: InMemoryEventBus,
  sourceSeq: number,
  command: Pick<AgentCommandExecutionObservedEvent, "command" | "aggregatedOutput">
    & Partial<Pick<AgentCommandExecutionObservedEvent, "status" | "exitCode">>,
): Promise<void> {
  const observedAt = `2026-09-05T00:01:0${sourceSeq}.000Z`;
  await eventBus.publishAndWait(AgentEvents.commandExecution.observed, {
    sourceSeq,
    agentId: "executor",
    role: "executor",
    taskId: "task-execute-001",
    threadId: "thread-executor",
    turnId: "turn-executor",
    itemId: `command-observed-${sourceSeq}`,
    command: command.command,
    status: command.status ?? "completed",
    exitCode: command.exitCode ?? 0,
    aggregatedOutput: command.aggregatedOutput,
    durationMs: 10,
    observedAt,
  } satisfies AgentCommandExecutionObservedEvent, { occurredAt: observedAt });
}
