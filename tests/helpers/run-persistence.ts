import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import type { Logger } from "../../src/core/logging/index.js";
import type { ScoutDomain } from "../../src/domain/index.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/index.js";
import type { RuntimeInteractionPort } from "../../src/interaction/index.js";
import {
  RunJournal,
  RunJournalWriter,
} from "../../src/run/journal/index.js";
import { RunEvents } from "../../src/run/events/index.js";
import { RunManifestStore } from "../../src/run/persistence/index.js";
import {
  installRunScope,
  RunScope,
} from "../../src/run/run-scope.js";
import type { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";
import type { RunEnvironment } from "../../src/run/types.js";
import {
  createGraphState,
  Scheduler,
} from "../../src/core/workflow/index.js";

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const testDomain: ScoutDomain = {
  domainId: "test",
  name: "test",
  dynamicToolsForRole: () => [],
};

export function createTestRunPersistence(
  t: TestContext,
  runId: string,
  scoutRoot = "/repo",
  eventBus = new InMemoryEventBus(),
  runRootOverride?: string,
  domain: ScoutDomain = testDomain,
): {
  runRoot: string;
  journal: RunJournal;
  manifestStore: RunManifestStore;
  scheduler: Scheduler;
} {
  const root = runRootOverride === undefined
    ? mkdtempSync(join(tmpdir(), "scout-run-test-"))
    : undefined;
  const runRoot = runRootOverride ?? join(root!, runId);
  const journal = RunJournal.create({ runId, runRoot });
  const manifestStore = new RunManifestStore(runRoot);
  const scheduler = createTestScheduler(eventBus);
  const scope = new RunScope({
    runId,
    scoutRoot,
    runRoot,
    logger: noopLogger,
    eventBus,
    scheduler,
    interactionPort: new NoopRuntimeInteractionPort(),
    domain,
    journal,
    manifestStore,
    terminate: async () => undefined,
  });
  const releaseScope = installRunScope(scope);
  const writer = new RunJournalWriter();
  writer.start();
  const createdAt = new Date().toISOString();
  eventBus.publish(
    RunEvents.run.created,
    { runId, scoutRoot, createdAt },
    { occurredAt: createdAt },
  );
  scheduler.initialize();
  if (journal.lastSeq !== 2) {
    throw new Error(`Test run ${runId} did not persist run.created and Workflow initialization.`);
  }
  manifestStore.create({
    runId,
    scoutRoot,
    createdAt,
    checkpointSeq: journal.lastSeq,
  });
  releaseScope();
  t.after(() => {
    writer.stop();
    journal.close();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });
  return { runRoot, journal, manifestStore, scheduler };
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
    journal?: RunJournal;
    manifestStore?: RunManifestStore;
    appServer?: CodexAppServerClient;
    environment?: RunEnvironment;
    scheduler?: Scheduler;
    terminate?(reason: string): Promise<void>;
  },
): RunScope {
  const scoutRoot = options.scoutRoot ?? "/repo";
  const eventBus = options.eventBus ?? new InMemoryEventBus();
  const persistence = options.journal && options.manifestStore
    ? {
      runRoot: options.runRoot ?? options.journal.runRoot,
      journal: options.journal,
      manifestStore: options.manifestStore,
      scheduler: options.scheduler ?? createTestScheduler(eventBus),
    }
    : createTestRunPersistence(
      t,
      options.runId,
      scoutRoot,
      eventBus,
      options.runRoot,
      options.domain,
    );
  const scope = new RunScope({
    runId: options.runId,
    scoutRoot,
    logger: options.logger ?? noopLogger,
    eventBus,
    interactionPort: options.interactionPort ?? new NoopRuntimeInteractionPort(),
    domain: options.domain ?? testDomain,
    ...persistence,
    scheduler: options.scheduler ?? persistence.scheduler,
    terminate: options.terminate ?? (async () => undefined),
  });
  if (options.appServer) scope.setAppServer(options.appServer);
  if (options.environment) scope.setEnvironment(options.environment);
  const release = installRunScope(scope);
  t.after(() => {
    if (options.appServer) scope.clearAppServer(options.appServer);
    release();
  });
  return scope;
}

/** Creates the smallest valid Scheduler used by isolated run tests. */
export function createTestScheduler(eventBus = new InMemoryEventBus()): Scheduler {
  return new Scheduler(createGraphState({
    domain: "test",
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
  }), eventBus);
}
