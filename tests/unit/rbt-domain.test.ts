import assert from "node:assert/strict";
import {
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
import type { ShellToolContract } from "../../src/asset-store/contracts/resources.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { createGraphState, Scheduler } from "../../src/core/workflow/index.js";
import {
  JarvisBehaviorTool,
  RbtAgentDynamicToolBackend,
  RbtDomain,
  RbtEvents,
} from "../../src/domain/rbt/index.js";
import { DomainEvents, UnityPipelineTool } from "../../src/domain/index.js";
import type { RunEnvironment } from "../../src/run/types.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("RBT Domain exposes platform and behavior dynamic tools by Phase", (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = new RbtDomain();
  installTestRunScope(t, {
    runId: "run-rbt-tools",
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
  });

  assert.deepEqual(domain.dynamicToolsForPhase("execute").map((tool) => [
    tool.name,
    tool.guidanceSkill,
  ]), [
    ["UnityPipeline", "tool-unity-pipeline"],
    ["JarvisBehavior", "tool-rbt-behavior"],
  ]);
  assert.deepEqual(domain.dynamicToolsForPhase("review").map((tool) => tool.name), [
    "JarvisBehavior",
  ]);
  assert.deepEqual(domain.dynamicToolsForPhase("Synthesis"), []);
});

test("RBT Domain executes Unity Pipeline directly through the shared Domain tool", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain({ unity: fakeUnityStatusTool() });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-unity-pipeline",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
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
  t.after(() => domain.stop());

  const response = await domain.handleDynamicToolCall(dynamicCall({
    callId: "call-unity-status",
    namespace: "rbt_unity_pipeline",
    tool: "UnityPipeline",
    arguments: { operation: "status" },
    role: "executor",
  }));

  assert.ok(response?.success);
  const output = JSON.parse(response.contentItems[0]?.text ?? "null") as {
    status: string;
    result: { count: number; instances: Array<{ version: string; state: string }> };
  };
  assert.equal(output.status, "completed");
  assert.deepEqual(output.result, {
    count: 1,
    instances: [{ version: "6000.0.80f1", state: "ready" }],
  });
});

test("JarvisBehavior prepares Play Mode without an Agent UnityPipeline call", async (t) => {
  const eventBus = new InMemoryEventBus();
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-platform-gate-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const markerPath = join(root, "unity-operations.log");
  const domain = rbtDomain({
    jarvis: (phase) => fakeJarvisTool(
      phase,
      undefined,
      fakeUnityStartingTool(markerPath),
    ),
  });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-platform-gate",
    runRoot: join(root, "run"),
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  await domain.start();
  t.after(() => domain.stop());

  const response = await domain.handleDynamicToolCall(dynamicCall({
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
  ]);
});

test("JarvisBehavior reports an unavailable human-prepared Unity Editor", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain({
    jarvis: (phase) => fakeJarvisTool(phase, undefined, fakeUnityUnavailableTool()),
  });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-platform-unavailable",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  await domain.start();
  t.after(() => domain.stop());

  const response = await domain.handleDynamicToolCall(dynamicCall({
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
      code: "unity_editor_unavailable",
      message: "No connected Unity Editor is available.",
    },
  });
});

test("JarvisBehavior blocks RBT while the Unity Editor is compiling", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain({
    jarvis: (phase) => fakeJarvisTool(phase, undefined, fakeUnityReadinessTool({ compiling: true })),
  });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-platform-compiling",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  await domain.start();
  t.after(() => domain.stop());

  const response = await domain.handleDynamicToolCall(dynamicCall({
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
      message: "The Unity Editor is compiling; RBT execution must stop until it is stable.",
    },
  });
});

test("JarvisBehavior blocks RBT during Unity domain reload and version changes", async (t) => {
  const cases = [
    {
      runId: "run-rbt-platform-domain-reload",
      tool: fakeUnityReadinessTool({ domainReloadInProgress: true }),
      code: "unity_editor_domain_reload",
      message: "The Unity Editor domain reload is in progress; RBT execution must stop until it is stable.",
    },
    {
      runId: "run-rbt-platform-version-changed",
      tool: fakeUnityReadinessTool({ editorVersion: "6000.0.81f1" }),
      code: "unity_editor_version_changed",
      message: "The connected Unity Editor version changed during the RBT execution.",
    },
  ] as const;

  for (const item of cases) {
    await t.test(item.runId, async (testContext) => {
      const eventBus = new InMemoryEventBus();
      const domain = rbtDomain({
        jarvis: (phase) => fakeJarvisTool(phase, undefined, item.tool),
      });
      const scope = installTestRunScope(testContext, {
        runId: item.runId,
        scoutRoot: process.cwd(),
        eventBus,
        domain,
        scheduler: rbtScheduler(eventBus),
      });
      const roots = roleRoots(scope.runRoot, "executor");
      const codebaseRoot = installBehaviorSchema(scope.runRoot);
      scope.setEnvironment(rbtEnvironment(scope.runId, {
        executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
      }));
      await domain.start();
      testContext.after(() => domain.stop());

      const response = await domain.handleDynamicToolCall(dynamicCall({
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
  const domain = rbtDomain({
    jarvis: (phase) => fakeJarvisTool(phase, undefined, fakeUnityReadinessTool({ instanceState: "starting" })),
  });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-platform-starting",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  await domain.start();
  t.after(() => domain.stop());

  const response = await domain.handleDynamicToolCall(dynamicCall({
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
      message: "The connected Unity Editor is not ready for RBT execution.",
    },
  });
});

test("RBT Agent tool-call recorder consumes the shared Domain event", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = new RbtDomain();
  const scope = installTestRunScope(t, {
    runId: "run-rbt-shared-tool-event",
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [], shellTools: [] },
  }));
  await domain.start();
  t.after(() => domain.stop());

  await eventBus.publishAndWait(DomainEvents.agentToolCall.observed, {
    domainId: "rbt",
    callId: "call-unity-status",
    threadId: "thread-executor",
    agentId: "executor",
    role: "executor",
    phase: "execute",
    namespace: "rbt_unity_pipeline",
    tool: "UnityPipeline",
    arguments: { operation: "status" },
    response: {
      success: true,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify({ status: "completed", result: { count: 1 } }),
      }],
    },
    startedAt: "2026-09-10T00:00:00.000Z",
    completedAt: "2026-09-10T00:00:01.000Z",
  });

  const log = readFileSync(join(roots.logsRoot, "rbt-agent-tool-call.log"), "utf8");
  assert.match(log, /domain\.shared\.agent_tool_call\.observed/);
  assert.match(log, /call-unity-status/);
  assert.match(log, /status: "completed"/);
  assert.doesNotMatch(log, /contentItems/);
});

test("RBT Domain exposes only agent-facing Unity Pipeline result fields", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain({ unity: fakeUnityResultsTool() });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-unity-pipeline-results",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
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
  t.after(() => domain.stop());

  const listResponse = await domain.handleDynamicToolCall(dynamicCall({
    callId: "call-unity-list",
    namespace: "rbt_unity_pipeline",
    tool: "UnityPipeline",
    arguments: { operation: "list" },
    role: "executor",
  }));
  const listOutput = JSON.parse(listResponse?.contentItems[0]?.text ?? "null") as {
    result: unknown;
  };
  assert.deepEqual(listOutput.result, {
    count: 2,
    commands: ["editor_play", "editor_status"],
  });

  const statusResponse = await domain.handleDynamicToolCall(dynamicCall({
    callId: "call-unity-editor-status",
    namespace: "rbt_unity_pipeline",
    tool: "UnityPipeline",
    arguments: { operation: "editor_status" },
    role: "executor",
  }));
  const statusOutput = JSON.parse(statusResponse?.contentItems[0]?.text ?? "null") as {
    result: unknown;
  };
  assert.deepEqual(statusOutput.result, {
    status: "ready",
    playMode: "playing",
    compiling: false,
    domainReloadInProgress: false,
    unityVersion: "6000.0.80f1",
  });
});

test("RBT Domain records one campaign history from dynamic behavior inputs and host outputs", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain({ jarvis: fakeJarvisTool });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-history",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
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
  const campaignEvents: string[] = [];
  eventBus.subscribe(RbtEvents.campaign, (event) => {
    campaignEvents.push(event.key.routeKey);
  });
  await domain.start();
  t.after(() => domain.stop());

  const { executeFilePath } = writeTestExecuteFile(roots.artifactRoot);
  const execution = await domain.handleDynamicToolCall(dynamicCall({
    callId: "call-execute-file",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { execute_file: executeFilePath },
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
    platform: { type: string; version: string };
    status: string;
    commands: Array<{
      input: { command: string; payload: Record<string, unknown> };
      request: { correlationId: string };
      hostCommands: Array<{ executable: string; args: string[]; result: { stdout: string } }>;
    }>;
  };
  assert.equal(history.executeFileRef,
    "account-anon-restore-existing-account/26.7.0-rc.2/execute-file.json");
  assert.equal(history.runtimeSequence, 1);
  assert.deepEqual(history.platform, {
    type: "unity_editor",
    version: "6000.0.80f1",
  });
  assert.equal(history.status, "completed");
  assert.equal("artifactType" in history, false);
  assert.equal("artifactVersion" in history, false);
  assert.equal("campaignId" in history, false);
  assert.equal("scenarioId" in history, false);
  assert.equal("runId" in history, false);
  assert.equal("agentId" in history, false);
  assert.equal("role" in history, false);
  assert.equal("artifactRef" in history, false);
  assert.equal(history.commands.length, 5);
  assert.equal(history.commands[0]?.input.command, "behavior.campaign.start");
  assert.equal(history.commands[4]?.input.command, "behavior.campaign.stop");
  assert.match(history.commands[0]?.request.correlationId ?? "", /^run-rbt-history\/cmd\/001-/);
  assert.equal("correlationId" in (history.commands[0]?.input ?? {}), false);
  assert.ok((history.commands[0]?.hostCommands.length ?? 0) >= 3);
  assert.equal(history.commands[0]?.hostCommands[0]?.executable, process.execPath);
  const behaviorCall = history.commands[0]?.hostCommands.at(-1);
  const schemaFlag = behaviorCall?.args.indexOf("--schema") ?? -1;
  assert.ok(schemaFlag >= 0);
  assert.equal(
    behaviorCall?.args[schemaFlag + 1],
    join(codebaseRoot, "gurusdk-framework", "contracts", "schemas"),
  );
  assert.match(history.commands[0]?.hostCommands.at(-1)?.result.stdout ?? "", /^\[RESULT\]/);

  assert.equal("journal" in domain, false);

  const replay = await domain.handleDynamicToolCall(dynamicCall({
    callId: "call-execute-file-replay",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { execute_file: executeFilePath },
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
  assert.equal(replayHistory.executeFileRef, history.executeFileRef);
  assert.deepEqual(replayHistory.platform, history.platform);
});

test("RBT execute-file rejects an array-shaped evidenceCapture before Runtime", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain({ jarvis: fakeJarvisTool });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-evidence-capture-contract",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
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
  t.after(() => domain.stop());

  const { executeFilePath } = writeTestExecuteFile(roots.artifactRoot);
  const executeFile = JSON.parse(readFileSync(executeFilePath, "utf8")) as {
    commands: Array<{ payload: Record<string, unknown> }>;
  };
  executeFile.commands[1]!.payload.evidenceCapture = [];
  writeFileSync(executeFilePath, `${JSON.stringify(executeFile, null, 2)}\n`, "utf8");

  const response = await domain.handleDynamicToolCall(dynamicCall({
    callId: "call-invalid-evidence-capture",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { execute_file: executeFilePath },
    role: "executor",
  }));

  assert.equal(response?.success, false);
  assert.match(
    response?.contentItems[0]?.text ?? "",
    /behavior\.scenario\.activate payload\.evidenceCapture must be an object\./,
  );
});

test("RBT execute-file continues the sequence when campaign history publication fails", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain({ jarvis: fakeJarvisTool });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-history-publication-failure",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
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
  t.after(() => domain.stop());

  const response = await domain.handleDynamicToolCall(dynamicCall({
    callId: "call-execute-file-history-publication-failure",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { execute_file: executeFilePath },
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
  const domain = rbtDomain({ jarvis: fakeJarvisTool });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-history-resume",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
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
  t.after(() => domain.stop());

  const response = await domain.handleDynamicToolCall(dynamicCall({
    callId: "call-execute-file-after-resume",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { execute_file: executeFilePath },
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
  const domain = rbtDomain({
    jarvis: (phase) => fakeJarvisTool(phase, "behavior.trigger.invoke"),
  });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-cleanup",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  const { executeFilePath } = writeTestExecuteFile(roots.artifactRoot);
  await domain.start();
  t.after(() => domain.stop());

  const response = await domain.handleDynamicToolCall(dynamicCall({
    callId: "call-execute-file-failure",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { execute_file: executeFilePath },
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

test("RBT dynamic-tool backend rejects a tool that is not registered for the call Phase", (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = new RbtDomain();
  installTestRunScope(t, {
    runId: "run-rbt-unregistered-phase-tool",
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
  });

  return domain.handleDynamicToolCall(dynamicCall({
    callId: "call-unregistered-phase-tool",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { command: "behavior.node.variants", payload: { id: "node" } },
    role: "coordinator",
  })).then((response) => {
    assert.equal(response?.success, false);
    assert.match(response?.contentItems[0]?.text ?? "", /has no registered dynamic tools/);
  });
});

test("RBT Domain rejects mutating behavior commands from a review role", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = new RbtDomain();
  const scope = installTestRunScope(t, {
    runId: "run-rbt-review-boundary",
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
  });
  const roots = roleRoots(scope.runRoot, "reviewer");
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    reviewer: { ...roots, readableRoots: [], shellTools: [] },
  }));
  await domain.start();
  t.after(() => domain.stop());

  const response = await domain.handleDynamicToolCall(dynamicCall({
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

test("RBT Domain projects a Runtime error without exposing its result envelope", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain({ jarvis: fakeJarvisTool });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-debug-gate",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
  });
  const roots = roleRoots(scope.runRoot, "reviewer");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    reviewer: {
      ...roots,
      readableRoots: [codebaseRoot],
      shellTools: [],
    },
  }));
  await domain.start();
  t.after(() => domain.stop());

  const response = await domain.handleDynamicToolCall(dynamicCall({
    callId: "call-debug-required",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: {
      command: "behavior.evidence.query",
      payload: { sourceId: "<source-id>" },
    },
    role: "reviewer",
  }));

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
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runRoot = join(root, "run-rbt-query-reconnect");
  const markerPath = join(runRoot, "query-disconnected-once");
  const domain = rbtDomain({
    jarvis: (phase) => fakeJarvisReconnectTool(phase, markerPath),
  });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-query-reconnect",
    runRoot,
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
  });
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  await domain.start();
  t.after(() => domain.stop());

  const response = await domain.handleDynamicToolCall(dynamicCall({
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

function roleRoots(runRoot: string, role: string): {
  artifactRoot: string;
  logsRoot: string;
} {
  return {
    artifactRoot: join(runRoot, "agents", role, "artifacts"),
    logsRoot: join(runRoot, "agents", role, "logs"),
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

function rbtDomain(input: {
  unity?: UnityPipelineTool;
  jarvis?: (phase: "execute" | "review") => JarvisBehaviorTool;
} = {}): RbtDomain {
  return new RbtDomain(new RbtAgentDynamicToolBackend({
    ...(input.unity ? {
      unityPipeline: () => input.unity!,
    } : {}),
    ...(input.jarvis ? { jarvisBehavior: input.jarvis } : {}),
  }));
}

function fakeUnityStatusTool(): UnityPipelineTool {
  const script = [
    "const args = process.argv.slice(1);",
    "process.stdout.write(JSON.stringify({",
    "  success: true,",
    "  command: 'status',",
    "  data: {",
    "    count: 1,",
    "    instances: [{",
    "      port: 12345,",
    "      project: '/workspace/project',",
    "      version: '6000.0.80f1',",
    "      pid: 23456,",
    "      state: 'ready'",
    "    }],",
    "    args",
    "  },",
    "  errors: [],",
    "  warnings: []",
    "}));",
  ].join("\n");
  return new UnityPipelineTool(process.execPath, ["-e", script, "--"]);
}

function fakeUnityResultsTool(): UnityPipelineTool {
  const script = [
    "const args = process.argv.slice(1);",
    "const isList = args.includes('list');",
    "const command = isList ? 'list' : 'command editor_status';",
    "const data = isList ? {",
    "  target: { host: '127.0.0.1', port: 12345 },",
    "  count: 2,",
    "  tools: [",
    "    { name: 'editor_play', description: 'play', group: 'built-in', parameters: [] },",
    "    { name: 'editor_status', description: 'status', group: 'built-in', parameters: [] }",
    "  ]",
    "} : {",
    "  command: 'editor_status',",
    "  parameters: {},",
    "  result: {",
    "    status: 'ready',",
    "    compiling: false,",
    "    domainReloadInProgress: false,",
    "    playMode: 'playing',",
    "    lastHeartbeat: '2026-09-10T00:00:00.000Z',",
    "    projectPath: '/workspace/project',",
    "    unityVersion: '6000.0.80f1'",
    "  },",
    "  target: { host: '127.0.0.1', port: 12345, projectPath: '/workspace/project' },",
    "  success: true",
    "};",
    "process.stdout.write(JSON.stringify({ success: true, command, data, errors: [], warnings: [] }));",
  ].join("\n");
  return new UnityPipelineTool(process.execPath, ["-e", script, "--"]);
}

function fakeUnityReadinessTool(input: {
  instanceState?: string;
  editorStatus?: string;
  compiling?: boolean;
  domainReloadInProgress?: boolean;
  editorVersion?: string;
  playMode?: string;
} = {}): UnityPipelineTool {
  const configuration = {
    instanceState: input.instanceState ?? "ready",
    editorStatus: input.editorStatus ?? "ready",
    compiling: input.compiling ?? false,
    domainReloadInProgress: input.domainReloadInProgress ?? false,
    editorVersion: input.editorVersion ?? "6000.0.80f1",
    playMode: input.playMode ?? "playing",
  };
  const script = [
    "const args = process.argv.slice(1);",
    `const config = ${JSON.stringify(configuration)};`,
    "const operation = args.includes('status') ? 'status' : args.includes('editor_status') ? 'editor_status' : args.includes('editor_play') ? 'editor_play' : '';",
    "const command = operation === 'status' ? 'status' : 'command ' + operation;",
    "const data = operation === 'status' ? {",
    "  count: 1,",
    "  instances: [{ version: config.editorVersion === '6000.0.81f1' ? '6000.0.80f1' : config.editorVersion, state: config.instanceState }]",
    "} : {",
    "  command: operation,",
    "  success: true,",
    "  result: {",
    "    status: config.editorStatus,",
    "    compiling: config.compiling,",
    "    domainReloadInProgress: config.domainReloadInProgress,",
    "    playMode: operation === 'editor_play' ? 'playing' : config.playMode,",
    "    unityVersion: config.editorVersion",
    "  }",
    "};",
    "process.stdout.write(JSON.stringify({ success: true, command, data, errors: [], warnings: [] }));",
  ].join("\n");
  return new UnityPipelineTool(process.execPath, ["-e", script, "--"]);
}

function fakeUnityPlayingTool(): UnityPipelineTool {
  const script = [
    "const args = process.argv.slice(1);",
    "const operation = args.includes('status') ? 'status' : args.includes('editor_status') ? 'editor_status' : args.includes('editor_play') ? 'editor_play' : '';",
    "const command = operation === 'status' ? 'status' : 'command ' + operation;",
    "const data = operation === 'status' ? {",
    "  count: 1,",
    "  instances: [{ version: '6000.0.80f1', state: 'ready' }]",
    "} : {",
    "  command: operation,",
    "  success: true,",
    "  result: {",
    "    status: 'ready',",
    "    compiling: false,",
    "    domainReloadInProgress: false,",
    "    playMode: 'playing',",
    "    unityVersion: '6000.0.80f1'",
    "  }",
    "};",
    "process.stdout.write(JSON.stringify({ success: true, command, data, errors: [], warnings: [] }));",
  ].join("\n");
  return new UnityPipelineTool(process.execPath, ["-e", script, "--"]);
}

function fakeUnityUnavailableTool(): UnityPipelineTool {
  const script = [
    "process.stdout.write(JSON.stringify({",
    "  success: true,",
    "  command: 'status',",
    "  data: { count: 0, instances: [] },",
    "  errors: [],",
    "  warnings: []",
    "}));",
  ].join("\n");
  return new UnityPipelineTool(process.execPath, ["-e", script, "--"]);
}

function fakeUnityStartingTool(markerPath: string): UnityPipelineTool {
  const script = [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(1);",
    "const operation = args.includes('status') ? 'status' : args.includes('editor_status') ? 'editor_status' : args.includes('editor_play') ? 'editor_play' : '';",
    `const markerPath = ${JSON.stringify(markerPath)};`,
    `const statePath = ${JSON.stringify(`${markerPath}.playing`)};`,
    "fs.appendFileSync(markerPath, operation + '\\n');",
    "if (operation === 'editor_play') fs.writeFileSync(statePath, 'playing\\n');",
    "const command = operation === 'status' ? 'status' : 'command ' + operation;",
    "const data = operation === 'status' ? {",
    "  count: 1,",
    "  instances: [{ version: '6000.0.80f1', state: 'ready' }]",
    "} : {",
    "  command: operation,",
    "  success: true,",
    "  result: operation === 'editor_play' ? 'Entered play mode' : {",
    "    status: 'ready',",
    "    compiling: false,",
    "    domainReloadInProgress: false,",
    "    playMode: fs.existsSync(statePath) ? 'playing' : 'stopped',",
    "    unityVersion: '6000.0.80f1'",
    "  }",
    "};",
    "process.stdout.write(JSON.stringify({ success: true, command, data, errors: [], warnings: [] }));",
  ].join("\n");
  return new UnityPipelineTool(process.execPath, ["-e", script, "--"]);
}

function writeTestExecuteFile(artifactRoot: string): {
  campaignId: string;
  executeFilePath: string;
} {
  const campaignId = "account.restore.success/campaign/main";
  const scenarioId = "account.restore.success";
  const executeFilePath = join(
    artifactRoot,
    "account-anon-restore-existing-account",
    "26.7.0-rc.2",
    "execute-file.json",
  );
  mkdirSync(join(executeFilePath, ".."), { recursive: true });
  writeFileSync(executeFilePath, `${JSON.stringify({
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

function fakeJarvisTool(
  phase: "execute" | "review",
  failedCommand?: string,
  unityPipeline = fakeUnityPlayingTool(),
): JarvisBehaviorTool {
  const script = [
    "const args = process.argv.slice(1);",
    "const sessionIndex = args.indexOf('--session');",
    "const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : 'session';",
    "if (args.includes('status')) {",
    "  process.stdout.write('WS session ' + sessionId + ': connected url=ws://127.0.0.1:8083 idle=1\\n');",
    "} else if (args.includes('schema') && args.includes('call')) {",
    "  const index = args.indexOf('--params-json');",
    "  const request = JSON.parse(args[index + 1]);",
    "  const payload = request.payload;",
    "  const debugRequired = payload.sourceId === '<source-id>';",
    `  const forcedFailure = request.type === ${JSON.stringify(failedCommand ?? "")};`,
    "  const failed = debugRequired || forcedFailure;",
    "  const result = {",
    "    type: 'behavior.command.result',",
    "    version: 1,",
    "    correlationId: request.correlationId,",
    "    status: failed ? 'error' : 'ok',",
    "    code: debugRequired ? 'debug_required' : forcedFailure ? 'forced_failure' : 'ok',",
    "    payload: debugRequired ? { message: 'DebugMode is required.' } : forcedFailure ? { message: 'Forced failure.' } : payload",
    "  };",
    "  process.stdout.write('[RESULT] ' + JSON.stringify(result) + '\\n');",
    "} else {",
    "  process.stdout.write('ok\\n');",
    "}",
  ].join("\n");
  return new JarvisBehaviorTool(
    phase,
    process.execPath,
    ["-e", script, "--"],
    unityPipeline,
  );
}

function fakeJarvisReconnectTool(
  phase: "execute" | "review",
  markerPath: string,
): JarvisBehaviorTool {
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
  return new JarvisBehaviorTool(
    phase,
    process.execPath,
    ["-e", script, "--"],
    fakeUnityPlayingTool(),
  );
}
