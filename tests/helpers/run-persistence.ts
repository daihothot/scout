import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { AssetStore, type AssetConfig, type WorkflowProfileAsset } from "../../src/asset-store/index.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { Journal } from "../../src/core/journal/index.js";
import type { Logger } from "../../src/core/logging/index.js";
import {
  BaseDomain,
  DomainAgentBackend,
  ScoutDomainId,
  type ScoutDomain,
} from "../../src/domain/index.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/index.js";
import type { RuntimeInteractionPort } from "../../src/interaction/index.js";
import { RunEvents } from "../../src/run/events/index.js";
import { RunManifestStore } from "../../src/run/persistence/index.js";
import {
  installRunScope,
  RunScope,
} from "../../src/run/run-scope.js";
import type { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";
import type { RunEnvironment } from "../../src/run/types.js";
import type { ExecutionPlatformPort } from "../../src/execution/scout-execution-system.js";
import { createGraphData, Graph, Workflow, WorkflowEvents, type WorkflowData, type GraphData } from "../../src/core/workflow/index.js";
import { ScoutBenchmarks } from "../../src/core/benchmarks/index.js";
import { Benchmarks } from "../../src/core/benchmarks/index.js";
import { testWorkflowParticipant } from "./workflow-participant.js";
import { WorkflowState } from "../../src/core/workflow/index.js";
import type { ScoutRecord } from "../../src/core/record/scout-record.js";

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const testDomain: ScoutDomain = {
  ...testWorkflowParticipant,
  description: { id: ScoutDomainId.Rbt, name: "Test Domain" },
  backend: new class extends DomainAgentBackend {
    override async handleDynamicToolCall() { return undefined; }
  }(),
};

export async function createTestRunPersistence(
  t: TestContext,
  runId: string,
  scoutRoot = "/repo",
  eventBus = new InMemoryEventBus(),
  runRootOverride?: string,
  graphOverride?: Graph,
): Promise<{
  runRoot: string;
  journal: {
    readonly runId: string;
    readonly runRoot: string;
    readonly path: string;
    readonly lastSeq: number;
    readAll(): ScoutRecord[];
  };
  manifestStore: RunManifestStore;
  workflow: Workflow;
  config: AssetConfig;
}> {
  const root = runRootOverride === undefined
    ? mkdtempSync(join(tmpdir(), "scout-run-test-"))
    : undefined;
  const runRoot = runRootOverride ?? join(root!, runId);
  const manifestStore = new RunManifestStore(runRoot);
  const runtimeGraph = graphOverride ?? createDefaultTestGraph();
  const workflowRoot = root ?? resolveTestWorkflowRoot(runRoot);
  // This fixture explicitly seeds an active Workflow; production startup remains empty.
  const benchmarks = new ScoutBenchmarks(new Benchmarks(runRoot));
  benchmarks.benchmarks.acquire();
  const prepared = benchmarks.prepareNext();
  const createdAt = new Date().toISOString();
  const seed = Journal.create({ journalId: `${runId}:workflow:scout`, path: join(prepared.journalRoot, "scout.journal"), lockPath: join(prepared.journalRoot, ".scout.lock") });
  seed.append({ id: `${runId}-created`, key: RunEvents.run.created, payload: { runId, scoutRoot, createdAt }, occurredAt: createdAt });
  seed.append({ id: `${runId}-initialized`, key: WorkflowEvents.workflow.initialized, payload: { state: runtimeGraph.snapshot(), initializedAt: createdAt }, occurredAt: createdAt });
  seed.close();
  benchmarks.recordStarted(prepared.workflowId);
  benchmarks.benchmarks.release();
  const workflow = new Workflow(createTestWorkflowAsset(runtimeGraph.snapshot()));
  const config = new AssetStore().config(scoutRoot);
  const scope = new RunScope({
    runId,
    scoutRoot: workflowRoot,
    runRoot,
    logger: noopLogger,
    eventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    config,
    workflow,
    manifestStore,
    terminate: async () => undefined,
  });
  const releaseScope = installRunScope(scope);
  manifestStore.create({ runId, scoutRoot, createdAt, checkpointSeq: 0 });
  await workflow.start();
  await workflow.enterState({ state: WorkflowState.Restoring, input: { graphData: runtimeGraph.snapshot(), workflowData: { workflowId: prepared.workflowId, status: "active", checkpointSeq: 2 }, journalRoot: prepared.journalRoot } });
  if (workflow.lastSeq !== 2) {
    throw new Error(`Test run ${runId} did not persist run.created and Workflow initialization.`);
  }
  manifestStore.update((manifest) => ({ ...manifest, checkpointSeq: workflow.lastSeq }));
  releaseScope();
  const journal = {
    runId,
    get runRoot() {
      return workflow.journalRoot;
    },
    get path() {
      return workflow.journalPath;
    },
    get lastSeq() {
      return workflow.lastSeq;
    },
    readAll: () => workflow.readEvents(),
  };
  t.after(async () => {
    await workflow.stop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });
  return {
    runRoot,
    journal,
    manifestStore,
    workflow,
    config,
  };
}

export async function installTestRunScope(
  t: TestContext,
  options: {
    runId: string;
    scoutRoot?: string;
    runRoot?: string;
    logger?: Logger;
    eventBus?: InMemoryEventBus;
    interactionPort?: RuntimeInteractionPort;
    domain?: ScoutDomain;
    workflow?: Workflow;
    manifestStore?: RunManifestStore;
    appServer?: CodexAppServerClient;
    environment?: RunEnvironment;
    runtimeGraph?: Graph;
    executionSystem?: ExecutionPlatformPort;
    workflowData?: WorkflowData;
    terminate?(reason: string): Promise<void>;
  },
): Promise<RunScope> {
  const scoutRoot = options.scoutRoot ?? "/repo";
  const eventBus = options.eventBus ?? new InMemoryEventBus();
  const persistence = options.workflow && options.manifestStore
    ? {
      runRoot: options.runRoot ?? dirname(options.manifestStore.path),
      workflow: options.workflow,
      manifestStore: options.manifestStore,
      config: new AssetStore().config(scoutRoot),
    }
    : await createTestRunPersistence(
      t,
      options.runId,
      scoutRoot,
      eventBus,
      options.runRoot,
      options.runtimeGraph,
    );
  const scope = new RunScope({
    runId: options.runId,
    scoutRoot,
    logger: options.logger ?? noopLogger,
    eventBus,
    interactionPort: options.interactionPort ?? new NoopRuntimeInteractionPort(),
    ...persistence,
    terminate: options.terminate ?? (async () => undefined),
  });
  const executionSystem = options.executionSystem ?? {
    identify: async () => ({
      ok: false as const,
      code: "test_execution_unavailable",
      message: "No execution system was configured for this test.",
    }),
    launch: async () => ({
      ok: false as const,
      code: "test_execution_unavailable",
      message: "No execution system was configured for this test.",
    }),
    shutdown: async () => ({
      ok: false as const,
      code: "test_execution_unavailable",
      message: "No execution system was configured for this test.",
    }),
  } satisfies ExecutionPlatformPort;
  scope.setExecutionSystem(executionSystem);
  if (options.appServer) scope.setAppServer(options.appServer);
  if (options.environment) scope.setEnvironment(options.environment);
  const release = installRunScope(scope);
  const domain = options.domain ?? testDomain;
  const baseDomain = new BaseDomain();
  scope.domainRegistry.register(baseDomain);
  scope.domainRegistry.register(domain);
  baseDomain.start();
  scope.workflow.registerParticipant(baseDomain);
  scope.workflow.registerParticipant(domain);
  t.after(async () => {
    await domain.stop?.();
    baseDomain.stop();
    if (scope.workflow.participants.includes(domain)) scope.workflow.unregisterParticipant(domain);
    if (scope.workflow.participants.includes(baseDomain)) scope.workflow.unregisterParticipant(baseDomain);
    if (options.appServer) scope.clearAppServer(options.appServer);
    release();
  });
  return scope;
}

function resolveTestWorkflowRoot(runRoot: string): string {
  return dirname(dirname(runRoot));
}

/** Static Asset fixture for tests that supply custom graph definitions. */
export function createTestWorkflowAsset(state: GraphData): WorkflowProfileAsset {
  return {
    name: state.workflowProfile, sourcePath: `workflows/${state.workflowProfile}.json`, hash: "test-asset",
    profile: {
      domain: state.domain,
      defaults: { config: "test", model: { id: "gpt-5", provider: "openai", reasoningEffort: "medium", reasoningSummary: "auto" }, maxThreads: 1, maxDepth: 1 },
      phases: { workers: Object.fromEntries(state.phases.map((phase) => [phase.name, { edges: phase.edges }])) },
      resources: {},
      roles: Object.fromEntries(state.roles.map((role) => [role.name, {
        multiAgent: false, customAgents: [], ...(role.name === "coordinator" ? {} : { phases: role.phases }),
      }])),
    },
  };
}

/** Builds runtime Graph fixtures, including explicitly selected recovery cursors. */
export function createTestGraph(state: GraphData): Graph {
  const graph = new Graph(createTestWorkflowAsset(state));
  graph.restore(state);
  return graph;
}

/** Creates the default Graph definition used by isolated run tests. */
export function createDefaultTestGraph(domain = "test"): Graph {
  return createTestGraph(createGraphData({
    domain: domain,
    workflowProfile: "test-workflow",
    phases: [
      {
        name: "research",
        edges: { completed: "research-reviewer", error: null },
        roles: ["researcher"],
      },
      {
        name: "research-reviewer",
        edges: { completed: "verify", error: "research" },
        roles: ["validator"],
      },
      {
        name: "verify",
        edges: { completed: "verify-reviewer", error: null },
        roles: ["verifier"],
      },
      {
        name: "verify-reviewer",
        edges: { completed: null, error: "verify" },
        roles: ["validator"],
      },
    ],
    roles: [
      { name: "coordinator", phases: ["Synthesis"] },
      { name: "researcher", phases: ["research"] },
      { name: "verifier", phases: ["verify"] },
      { name: "validator", phases: ["research-reviewer", "verify-reviewer"] },
    ],
    currentPhase: "research",
  }));
}
