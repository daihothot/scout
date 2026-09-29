import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { AssetStore, type AssetConfig } from "../../src/asset-store/index.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { Journal, type JournalEvent } from "../../src/core/journal/index.js";
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
import {
  createGraphState,
  Graph,
  Scheduler,
  Workflow,
  Benchmarks,
  ScoutBenchmarks,
  WorkflowEvents,
  type WorkflowState,
} from "../../src/core/workflow/index.js";

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const testDomain: ScoutDomain = {
  description: { id: ScoutDomainId.Validation, name: "Test Domain" },
  backend: new class extends DomainAgentBackend {
    override async handleDynamicToolCall() { return undefined; }
  }(),
};

export function createTestRunPersistence(
  t: TestContext,
  runId: string,
  scoutRoot = "/repo",
  eventBus = new InMemoryEventBus(),
  runRootOverride?: string,
  schedulerOverride?: Scheduler,
): {
  runRoot: string;
  journal: {
    readonly runId: string;
    readonly runRoot: string;
    readonly path: string;
    readonly lastSeq: number;
    readAll(): JournalEvent[];
  };
  manifestStore: RunManifestStore;
  workflow: Workflow;
  config: AssetConfig;
} {
  const root = runRootOverride === undefined
    ? mkdtempSync(join(tmpdir(), "scout-run-test-"))
    : undefined;
  const runRoot = runRootOverride ?? join(root!, runId);
  const manifestStore = new RunManifestStore(runRoot);
  const scheduler = schedulerOverride ?? createTestScheduler();
  const workflowRoot = root ?? resolveTestWorkflowRoot(runRoot);
  // This fixture explicitly seeds an active Workflow; production startup remains empty.
  const benchmarks = new ScoutBenchmarks(new Benchmarks(runRoot));
  benchmarks.benchmarks.acquire();
  const prepared = benchmarks.prepareNext();
  const createdAt = new Date().toISOString();
  const seed = Journal.create({ journalId: `${runId}:workflow:scout`, path: join(prepared.journalRoot, "scout.journal"), lockPath: join(prepared.journalRoot, ".scout.lock") });
  seed.append({ id: `${runId}-created`, key: RunEvents.run.created, payload: { runId, scoutRoot, createdAt }, occurredAt: createdAt });
  seed.append({ id: `${runId}-initialized`, key: WorkflowEvents.workflow.initialized, payload: { state: scheduler.snapshot(), initializedAt: createdAt }, occurredAt: createdAt });
  seed.close();
  benchmarks.recordStarted(prepared.workflowId);
  benchmarks.benchmarks.release();
  const workflow = new Workflow({
    graphState: scheduler.snapshot(),
    resume: { workflowState: { workflowId: prepared.workflowId, status: "active", checkpointSeq: 2 }, journalRoot: prepared.journalRoot },
  });
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
  void workflow.start();
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

export function installTestRunScope(
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
    scheduler?: Scheduler;
    executionSystem?: ExecutionPlatformPort;
    workflowState?: WorkflowState;
    terminate?(reason: string): Promise<void>;
  },
): RunScope {
  const scoutRoot = options.scoutRoot ?? "/repo";
  const eventBus = options.eventBus ?? new InMemoryEventBus();
  const persistence = options.workflow && options.manifestStore
    ? {
      runRoot: options.runRoot ?? dirname(options.manifestStore.path),
      workflow: options.workflow,
      manifestStore: options.manifestStore,
      config: new AssetStore().config(scoutRoot),
    }
    : createTestRunPersistence(
      t,
      options.runId,
      scoutRoot,
      eventBus,
      options.runRoot,
      options.scheduler,
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
  t.after(async () => {
    await domain.stop?.();
    baseDomain.close();
    if (options.appServer) scope.clearAppServer(options.appServer);
    release();
  });
  return scope;
}

function resolveTestWorkflowRoot(runRoot: string): string {
  return dirname(dirname(runRoot));
}

/** Creates the smallest valid Scheduler used by isolated run tests. */
export function createTestScheduler(domain = "test"): Scheduler {
  return new Scheduler(new Graph(createGraphState({
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
  })));
}
