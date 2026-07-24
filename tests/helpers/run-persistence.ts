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
  repoRoot = "/repo",
  eventBus = new InMemoryEventBus(),
): { journal: RunJournal; manifestStore: RunManifestStore } {
  const root = mkdtempSync(join(tmpdir(), "scout-run-test-"));
  const runRoot = join(root, runId);
  const journal = RunJournal.create({ runId, runRoot });
  const manifestStore = new RunManifestStore(runRoot);
  const scope = new RunScope({
    runId,
    repoRoot,
    logger: noopLogger,
    eventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: testDomain,
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
    { runId, repoRoot, createdAt },
    { occurredAt: createdAt },
  );
  if (journal.lastSeq !== 1) {
    throw new Error(`Test run ${runId} did not persist run.created.`);
  }
  manifestStore.create({
    runId,
    repoRoot,
    createdAt,
    checkpointSeq: journal.lastSeq,
  });
  releaseScope();
  t.after(() => {
    writer.stop();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { journal, manifestStore };
}

export function installTestRunScope(
  t: TestContext,
  options: {
    runId: string;
    repoRoot?: string;
    logger?: Logger;
    eventBus?: InMemoryEventBus;
    interactionPort?: RuntimeInteractionPort;
    domain?: ScoutDomain;
    journal?: RunJournal;
    manifestStore?: RunManifestStore;
    appServer?: CodexAppServerClient;
    environment?: RunEnvironment;
    terminate?(reason: string): Promise<void>;
  },
): RunScope {
  const repoRoot = options.repoRoot ?? "/repo";
  const eventBus = options.eventBus ?? new InMemoryEventBus();
  const persistence = options.journal && options.manifestStore
    ? {
      journal: options.journal,
      manifestStore: options.manifestStore,
    }
    : createTestRunPersistence(t, options.runId, repoRoot, eventBus);
  const scope = new RunScope({
    runId: options.runId,
    repoRoot,
    logger: options.logger ?? noopLogger,
    eventBus,
    interactionPort: options.interactionPort ?? new NoopRuntimeInteractionPort(),
    domain: options.domain ?? testDomain,
    ...persistence,
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
