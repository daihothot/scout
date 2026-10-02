import { testWorkflowParticipant } from "../helpers/workflow-participant.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDynamicToolBackend } from "../../src/agent/backend/dynamic-tool/agent-dynamic-tool-backend.js";
import type { ScoutAgent } from "../../src/agent/core/scout-agent.js";
import type { AgentDynamicToolSpec } from "../../src/agent/tools/types.js";
import {
  assertAgentToolNamespace,
  buildStartWorkflowDynamicTool,
  parseAgentDynamicToolCall,
} from "../../src/agent/tools/agent-tools.js";
import { AssetStore } from "../../src/asset-store/index.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { Logger } from "../../src/core/logging/index.js";
import { Workflow } from "../../src/core/workflow/index.js";
import { BaseDomainAgentBackend, BaseDomainToolCallStore, ScoutDomainId } from "../../src/domain/index.js";
import { RbtDomainAgentBackend } from "../../src/domain/domains/rbt/index.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/index.js";
import { RunManifestStore } from "../../src/run/persistence/index.js";
import { installRunScope, RunScope } from "../../src/run/run-scope.js";
import { createDefaultTestGraph, createTestWorkflowAsset } from "../helpers/run-persistence.js";

const unnamespacedTool: AgentDynamicToolSpec = {
  guidanceSkill: "tool-domain-probe",
  name: "Probe",
  description: "Exercises tool identity without a namespace.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

test("StartWorkflow exposes only the formal tool, namespace and guidance Skill contract", () => {
  const tool = buildStartWorkflowDynamicTool();
  assert.equal(tool.name, "StartWorkflow");
  assert.equal(tool.namespace, "scout_agent_startworkflow");
  assert.doesNotThrow(() => assertAgentToolNamespace("scout_agent_startworkflow", "StartWorkflow"));
  assert.deepEqual(parseAgentDynamicToolCall("StartWorkflow", { prompt: "Execute the requested work" }), {
    tool: "StartWorkflow", prompt: "Execute the requested work",
  });
  assert.throws(() => assertAgentToolNamespace("scout_agent_startflow", "StartWorkflow"), /must use namespace/);
  assert.throws(() => assertAgentToolNamespace("scout_agent_startflow", "StartFlow"), /Unsupported agent tool/);
  assert.throws(() => parseAgentDynamicToolCall("StartFlow", { prompt: "Execute the requested work" }), /Unsupported/);
});

test("Dynamic tool routing invokes an omitted-namespace definition for a null protocol namespace", async (t) => {
  const scope = await installNamespaceScope(t);
  const store = new BaseDomainToolCallStore();
  const backend = new BaseDomainAgentBackend(store);
  const calls: Array<string | null> = [];
  backend.register("research", {
    definition: unnamespacedTool,
    tool: { execute: (call) => {
      calls.push(call.input.namespace);
      return { success: true, contentItems: [{ type: "inputText", text: "executed" }] };
    } },
  });
  scope.domainRegistry.register({
    ...testWorkflowParticipant, description: { id: ScoutDomainId.Base, name: "Base" }, backend });

  const response = await new AgentDynamicToolBackend()
    .handleDynamicToolCall({
      threadId: "thread-researcher", turnId: "turn-1", callId: "call-1",
      namespace: null, tool: "Probe", arguments: {},
    });
  assert.equal(response.success, true);
  assert.deepEqual(calls, [null]);
  assert.deepEqual(store.list().map((call) => call.callId), ["call-1"]);
});

test("Dynamic tool routing does not match a named namespace to an omitted-namespace definition", async (t) => {
  const scope = await installNamespaceScope(t);
  const store = new BaseDomainToolCallStore();
  const backend = new BaseDomainAgentBackend(store);
  let invocationCount = 0;
  backend.register("research", {
    definition: unnamespacedTool,
    tool: { execute: () => {
      invocationCount += 1;
      return { success: true, contentItems: [] };
    } },
  });
  scope.domainRegistry.register({
    ...testWorkflowParticipant, description: { id: ScoutDomainId.Base, name: "Base" }, backend });

  const response = await new AgentDynamicToolBackend()
    .handleDynamicToolCall({
      threadId: "thread-researcher", turnId: "turn-1", callId: "call-1",
      namespace: "other_namespace", tool: "Probe", arguments: {},
    });
  assert.equal(response.success, false);
  assert.match(response.contentItems[0]?.text ?? "", /Unsupported dynamic tool namespace: other_namespace/);
  assert.equal(invocationCount, 0);
  assert.deepEqual(store.list(), []);
});

test("Dynamic tool routing rejects null-namespace collisions across Domains before executing either tool", async (t) => {
  const scope = await installNamespaceScope(t);
  const calls: ScoutDomainId[] = [];
  const backends = [
    { id: ScoutDomainId.Base, backend: new BaseDomainAgentBackend(new BaseDomainToolCallStore()) },
    { id: ScoutDomainId.Rbt, backend: new RbtDomainAgentBackend() },
  ];
  for (const { id, backend } of backends) {
    backend.register("research", {
      definition: unnamespacedTool,
      tool: { execute: () => {
        calls.push(id);
        return { success: true, contentItems: [] };
      } },
    });
    scope.domainRegistry.register({
    ...testWorkflowParticipant, description: { id, name: id }, backend });
  }

  const response = await new AgentDynamicToolBackend()
    .handleDynamicToolCall({
      threadId: "thread-researcher", turnId: "turn-1", callId: "call-1",
      namespace: null, tool: "Probe", arguments: {},
    });
  assert.equal(response.success, false);
  assert.match(response.contentItems[0]?.text ?? "", /registered by multiple Scout Domains: base, rbt/);
  assert.deepEqual(calls, []);
});

async function installNamespaceScope(t: TestContext): Promise<RunScope> {
  const root = mkdtempSync(join(tmpdir(), "scout-namespace-routing-"));
  const runId = "run-namespace-routing";
  const runRoot = join(root, "run", runId);
  const scope = new RunScope({
    runId,
    scoutRoot: root,
    runRoot,
    config: new AssetStore().config(root),
    workflow: new Workflow(createTestWorkflowAsset(createDefaultTestGraph().snapshot())),
    manifestStore: new RunManifestStore(runRoot),
    logger: new Logger({ runId, logsRoot: join(runRoot, "logs") }),
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    terminate: async () => {},
  });
  // This routing boundary consumes caller identity; Agent execution is outside the test.
  const caller = { agentId: "researcher", role: "researcher", threadId: "thread-researcher" } as ScoutAgent;
  t.mock.method(scope.agentRegistry, "resolveToolCaller", (threadId: string) =>
    threadId === caller.threadId ? caller : undefined
  );
  const release = installRunScope(scope);
  scope.manifestStore.create({ runId, scoutRoot: root, createdAt: new Date().toISOString(), checkpointSeq: 0 });
  await scope.workflow.start();
  await scope.workflow.startWorkflow();
  t.after(async () => {
    await scope.workflow.stop();
    release();
    rmSync(root, { recursive: true, force: true });
  });
  return scope;
}
