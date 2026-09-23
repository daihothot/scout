import assert from "node:assert/strict";
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
import type { ShellToolContract } from "../../src/asset-store/contracts/resources.js";
import { attachments } from "../../src/agent/context/attachments.js";
import { CoordinatorContextTags } from "../../src/agent/runner/coordinator/coordinator-attachments.js";
import type { ScoutAgent } from "../../src/agent/core/scout-agent.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { Result } from "../../src/core/result.js";
import { createGraphState, Scheduler } from "../../src/core/workflow/index.js";
import {
  JarvisBehaviorTool,
  JarvisWebSocketTool,
  RbtAgentDynamicToolBackend,
  RbtDomain,
  RbtEvents,
} from "../../src/domain/rbt/index.js";
import {
  DomainEvents,
  ExecutionPlatformTool,
} from "../../src/domain/index.js";
import {
  ScoutExecutionSystem,
  type ExecutionPlatformIdentity,
  type ExecutionPlatformPort,
} from "../../src/execution/scout-execution-system.js";
import type { ScoutDomainDynamicToolCall } from "../../src/domain/types.js";
import type { RunEnvironment } from "../../src/run/types.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("RBT Domain exposes behavior execution and final platform shutdown by Phase", (t) => {
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
    ["JarvisBehavior", "tool-rbt-behavior"],
  ]);
  assert.deepEqual(domain.dynamicToolsForPhase("review").map((tool) => tool.name), [
    "JarvisBehavior",
    "ExecutionPlatform",
  ]);
  assert.deepEqual(domain.dynamicToolsForPhase("Synthesis"), []);
});

test("ScoutExecutionSystem owns and reuses the connected transport session", async () => {
  const operations: string[] = [];
  const identity: ExecutionPlatformIdentity = {
    type: "unity_editor",
    version: "6000.0.80f1",
  };
  const system = new ScoutExecutionSystem({
    async invoke(args) {
      const operation = args[0] ?? "unknown";
      operations.push(operation);
      return operation === "identify"
        ? appPilotIdentityResponse(identity)
        : { id: operation, ok: true };
    },
    async close() {
      operations.push("close");
    },
  });

  assert.deepEqual(await system.launch(), { ok: true, identity });
  assert.deepEqual(await system.launch(), { ok: true, identity });
  assert.deepEqual(operations, ["identify", "launch", "launch"]);

  assert.deepEqual(await system.shutdown(), { ok: true, identity });
  assert.deepEqual(operations, [
    "identify",
    "launch",
    "launch",
    "shutdown",
  ]);

  assert.deepEqual(await system.shutdown(), { ok: true, identity });
  assert.deepEqual(operations.slice(-2), ["identify", "shutdown"]);
});

test("ScoutExecutionSystem serializes lifecycle operations and closes before disposal", async () => {
  const operations: string[] = [];
  const identity: ExecutionPlatformIdentity = {
    type: "unity_editor",
    version: "6000.0.80f1",
  };
  let activeOperations = 0;
  let maximumActiveOperations = 0;
  const system = new ScoutExecutionSystem({
    async invoke(args) {
      activeOperations += 1;
      maximumActiveOperations = Math.max(maximumActiveOperations, activeOperations);
      const operation = args[0] ?? "unknown";
      operations.push(operation);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeOperations -= 1;
      return operation === "identify"
        ? appPilotIdentityResponse(identity)
        : { id: operation, ok: true };
    },
    async close() {
      operations.push("close");
    },
  });

  const firstLaunch = system.launch();
  const secondLaunch = system.launch();
  const disposal = system.dispose();

  assert.deepEqual(await system.launch(), {
    ok: false,
    code: "execution_system_disposed",
    message: "The Scout execution system has been disposed.",
  });
  assert.deepEqual(await firstLaunch, { ok: true, identity });
  assert.deepEqual(await secondLaunch, { ok: true, identity });
  await disposal;

  assert.deepEqual(operations, ["identify", "launch", "launch", "shutdown", "close"]);
  assert.equal(maximumActiveOperations, 1);
});

test("ExecutionPlatform Agent tool delegates lifecycle work through RunScope", async (t) => {
  const identity: ExecutionPlatformIdentity = { type: "android", version: "34" };
  const operations: string[] = [];
  installTestRunScope(t, {
    runId: "run-execution-platform-tool",
    executionSystem: {
      async launch() {
        operations.push("launch");
        return { ok: true, identity };
      },
      async shutdown() {
        operations.push("shutdown");
        return { ok: true, identity };
      },
    },
  });
  const tool = new ExecutionPlatformTool();

  const result = await tool.execute(dynamicCall({
    callId: "call-execution-platform-launch",
    namespace: "domain_execution",
    tool: "ExecutionPlatform",
    arguments: { operation: "launch" },
    role: "executor",
  }) as ScoutDomainDynamicToolCall);
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.contentItems[0]?.text ?? "null"), {
    operation: "launch",
    status: "completed",
    identity,
  });
  assert.deepEqual(operations, ["launch"]);
});

test("RBT hides ExecutionPlatform from Executor", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = new RbtDomain();
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

  const call = dynamicCall({
    callId: "call-execution-platform",
    namespace: "domain_execution",
    tool: "ExecutionPlatform",
    arguments: { operation: "launch" },
    role: "executor",
  });

  const denied = await domain.handleDynamicToolCall(call);
  assert.equal(denied.success, false);
  assert.match(denied.contentItems[0]?.text ?? "", /ExecutionPlatform is not registered for Phase execute/);
});

test("RBT Reviewer shuts down the run-scoped execution session", async (t) => {
  const eventBus = new InMemoryEventBus();
  const identity: ExecutionPlatformIdentity = { type: "unity_editor", version: "6000.0.80f1" };
  const operations: string[] = [];
  const domain = new RbtDomain();
  installTestRunScope(t, {
    runId: "run-rbt-review-shutdown",
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
    executionSystem: {
      async launch() {
        operations.push("launch");
        return { ok: true, identity };
      },
      async shutdown() {
        operations.push("shutdown");
        return { ok: true, identity };
      },
    },
  });

  const response = await domain.handleDynamicToolCall(dynamicCall({
    callId: "call-review-shutdown",
    namespace: "domain_execution",
    tool: "ExecutionPlatform",
    arguments: { operation: "shutdown" },
    role: "reviewer",
  }));

  assert.equal(response.success, true);
  assert.deepEqual(JSON.parse(response.contentItems[0]?.text ?? "null"), {
    operation: "shutdown",
    status: "completed",
    identity,
  });
  assert.deepEqual(operations, ["shutdown"]);
});

test("JarvisBehavior prepares Play Mode without an Agent UnityPipeline call", async (t) => {
  const eventBus = new InMemoryEventBus();
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-platform-gate-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const markerPath = join(root, "unity-operations.log");
  const domain = rbtDomain({ jarvis: fakeJarvisTool });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-platform-gate",
    runRoot: join(root, "run"),
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
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
    "editor_status",
  ]);
});

test("JarvisBehavior reports Play Mode readiness timeout before WebSocket connection", async (t) => {
  const eventBus = new InMemoryEventBus();
  const root = mkdtempSync(join(tmpdir(), "scout-rbt-platform-timeout-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const markerPath = join(root, "unity-operations.log");
  const domain = rbtDomain({ jarvis: fakeJarvisTool });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-platform-timeout",
    runRoot: join(root, "run"),
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
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
  const roots = roleRoots(scope.runRoot, "executor");
  const codebaseRoot = installBehaviorSchema(scope.runRoot);
  scope.setEnvironment(rbtEnvironment(scope.runId, {
    executor: { ...roots, readableRoots: [codebaseRoot], shellTools: [] },
  }));
  await domain.start();
  t.after(() => domain.stop());

  const response = await domain.handleDynamicToolCall(dynamicCall({
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
  const domain = rbtDomain({ jarvis: fakeJarvisTool });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-platform-unavailable",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
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
      code: "transport_unavailable",
      message: "Transport unity-pipeline has no available platform.",
    },
  });
});

test("JarvisBehavior blocks RBT while the Unity Editor is compiling", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain({ jarvis: fakeJarvisTool });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-platform-compiling",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
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
      const domain = rbtDomain({ jarvis: fakeJarvisTool });
      const scope = installTestRunScope(testContext, {
        runId: item.runId,
        scoutRoot: process.cwd(),
        eventBus,
        domain,
        scheduler: rbtScheduler(eventBus),
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
  const domain = rbtDomain({ jarvis: fakeJarvisTool });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-platform-starting",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
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
      message: "The connected Unity Editor is not ready for execution.",
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

test("RBT Domain records one campaign history from dynamic behavior inputs and host outputs", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain({ jarvis: fakeJarvisTool });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-history",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
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
  assert.equal(history.executeFileRef,
    "account-anon-restore-existing-account/26.7.0-rc.2/execute-file.json");
  assert.equal(history.runtimeSequence, 1);
  assert.equal(history.campaignId, "account.restore.success/campaign/main");
  assert.equal(history.scenarioId, "account.restore.success");
  assert.deepEqual(history.platform, {
    type: "unity_editor",
    version: "6000.0.80f1",
  });
  assert.equal(history.status, "completed");
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
  assert.match(historyObservation, /executor_history_ref: agents\/executor\/artifacts\/history\/001\.json/);
  assert.match(historyObservation, /execute_file_ref: account-anon-restore-existing-account\/26\.7\.0-rc\.2\/execute-file\.json/);
  assert.match(historyObservation, /campaign_id: account\.restore\.success\/campaign\/main/);
  assert.match(historyObservation, /scenario_id: account\.restore\.success/);
  assert.match(historyObservation, /status: completed/);

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

test("RBT execute-file preflights every registry identity before campaign mutation", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain({ jarvis: fakeJarvisTool });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-identity-preflight",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
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
  t.after(() => domain.stop());

  const response = await domain.handleDynamicToolCall(dynamicCall({
    callId: "call-identity-preflight",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { execute_file: executeFilePath },
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
  const domain = rbtDomain({ jarvis: fakeJarvisTool });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-history-publication-failure",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
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
    executionSystem: fakeExecutionSystem(),
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

test("RBT Reviewer queries a campaign using the Executor-bound schema without codebase access", async (t) => {
  const eventBus = new InMemoryEventBus();
  const domain = rbtDomain({ jarvis: fakeJarvisTool });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-review-campaign",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
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
  t.after(() => domain.stop());

  const payload = { campaignId: "campaign-review", scenarioId: "scenario-review", includeEvidence: true };
  const response = await domain.handleDynamicToolCall(dynamicCall({
    callId: "call-review-campaign",
    namespace: "rbt_behavior",
    tool: "JarvisBehavior",
    arguments: { command: "behavior.campaign.query", payload },
    role: "reviewer",
  }));

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
  const domain = rbtDomain({ jarvis: fakeJarvisTool });
  const scope = installTestRunScope(t, {
    runId: "run-rbt-debug-gate",
    scoutRoot: process.cwd(),
    eventBus,
    domain,
    scheduler: rbtScheduler(eventBus),
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
    executionSystem: fakeExecutionSystem(),
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
  jarvis?: (phase: "execute" | "review") => JarvisBehaviorTool;
} = {}): RbtDomain {
  return new RbtDomain(new RbtAgentDynamicToolBackend({
    ...(input.jarvis ? { jarvisBehavior: input.jarvis } : {}),
  }));
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
  return new JarvisBehaviorTool(
    phase,
    process.execPath,
    ["-e", script, "--"],
  );
}

function fakeExecutionSystem(input: {
  onLaunch?: () => void;
  launchFailure?: { code: string; message: string };
} = {}): ExecutionPlatformPort {
  const identity: ExecutionPlatformIdentity = {
    type: "unity_editor",
    version: "6000.0.80f1",
  };
  return {
    async launch() {
      input.onLaunch?.();
      return input.launchFailure
        ? { ok: false, ...input.launchFailure }
        : { ok: true, identity };
    },
    async shutdown() {
      return { ok: true, identity };
    },
  };
}

function appPilotIdentityResponse(identity: ExecutionPlatformIdentity) {
  return {
    id: "identify",
    ok: true as const,
    value: {
      transport: "unity-pipeline",
      platform: { type: identity.type, version: identity.version },
    },
  };
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
  );
}
