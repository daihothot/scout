import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { agent } from "../../src/agent/context/agent-attachments.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import {
  type AgentThreadSnapshot,
} from "../../src/agent/thread/types.js";
import {
  EventSubscriptionPriorities,
  InMemoryEventBus,
} from "../../src/core/events/index.js";
import { WorkflowEvents } from "../../src/core/workflow/index.js";
import { Benchmarks, ScoutBenchmarks } from "../../src/core/benchmarks/index.js";
import { SystemEvents } from "../../src/system/events/index.js";
import { BaseDomain, ScoutDomainId } from "../../src/domain/index.js";
import type { RunScope } from "../../src/run/run-scope.js";
import {
  Journal,
  JournalWriter,
  type JournalLocation,
  readJournalEvents,
} from "../../src/core/journal/index.js";
import {
  RunEvents,
  type RunJournalWriteFailedEvent,
} from "../../src/run/events/index.js";
import { projectRun as projectRunEvents } from "../../src/run/resume/projection/index.js";
import {
  createTestRunPersistence,
  createTestScheduler,
  installTestRunScope,
} from "../helpers/run-persistence.js";

const projectRun = (events: Parameters<typeof projectRunEvents>[0]) =>
  projectRunEvents(events, "coordinator");

function baseDomain(scope: RunScope): BaseDomain {
  const domain = scope.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(domain instanceof BaseDomain);
  return domain;
}

test("Workflow Journal writer persists recovery events and excludes readiness telemetry", async (t) => {
  const eventBus = new InMemoryEventBus();
  const { journal, workflow } = createTestRunPersistence(
    t,
    "journal-sequence",
    "/repo",
    eventBus,
  );
  assert.equal(basename(journal.path), "scout.journal");
  await eventBus.publishAndWait(RunEvents.runtime.attached, {
    mode: "start",
    attachedAt: "2026-07-22T00:00:00.000Z",
    processId: process.pid,
  }, {
    occurredAt: "2026-07-22T00:00:00.000Z",
  });
  await eventBus.publishAndWait(RunEvents.runtime.ready, {
    mode: "start",
    readyAt: "2026-07-22T00:00:01.000Z",
  }, {
    occurredAt: "2026-07-22T00:00:01.000Z",
  });

  assert.equal(journal.readAll()[2]?.key.routeKey, RunEvents.runtime.attached.routeKey);
  assert.equal(
    journal.readAll().some((event) => RunEvents.runtime.ready.is(event)),
    false,
  );
  assert.deepEqual(journal.readAll().map((event) => event.seq), [1, 2, 3]);
  const location = scoutJournalLocation(journal.runId, journal.runRoot);
  assert.throws(
    () => Journal.open(location),
    /already attached/,
  );
  const lockPath = location.lockPath;
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { hostId: string };
  assert.equal(lock.hostId, hostname());
  await workflow.stop();
  assert.equal(existsSync(lockPath), false);
});

test("Journal replaces a stale lock only when it belongs to the current host", (t) => {
  const { journal, location } = createCoreJournal(t, "journal-stale-local-lock");
  const lockPath = location.lockPath;
  journal.close();
  writeFileSync(lockPath, `${JSON.stringify({
    journalId: journal.journalId,
    hostId: hostname(),
    processId: 2_147_483_647,
    token: "stale-local-token",
    acquiredAt: "2026-07-22T00:00:00.000Z",
  })}\n`, "utf8");

  const reopened = Journal.open(location);
  t.after(() => reopened.close());
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    hostId: string;
    processId: number;
    token: string;
  };
  assert.equal(lock.hostId, hostname());
  assert.equal(lock.processId, process.pid);
  assert.notEqual(lock.token, "stale-local-token");
});

test("Journal preserves and rejects a foreign-host lock", (t) => {
  const { journal, location } = createCoreJournal(t, "journal-foreign-lock");
  const lockPath = location.lockPath;
  journal.close();
  const foreignLock = `${JSON.stringify({
    journalId: journal.journalId,
    hostId: `${hostname()}-foreign`,
    processId: process.pid,
    token: "foreign-token",
    acquiredAt: "2026-07-22T00:00:00.000Z",
  })}\n`;
  writeFileSync(lockPath, foreignLock, "utf8");

  assert.throws(
    () => Journal.open(location),
    /locked by host .*foreign.*current host/,
  );
  assert.equal(readFileSync(lockPath, "utf8"), foreignLock);
});

test("Journal repairs an incomplete tail before the next append", async (t) => {
  const { journal, location } = createCoreJournal(t, "journal-tail");
  journal.append({
    id: "event-1",
    key: RunEvents.run.created,
    payload: { runId: "journal-tail", scoutRoot: "/repo", createdAt: "2026-07-22T00:00:00.000Z" },
    occurredAt: "2026-07-22T00:00:00.000Z",
  });
  journal.append({
    id: "event-2",
    key: WorkflowEvents.workflow.initialized,
    payload: {
      state: createTestScheduler().snapshot(),
      initializedAt: "2026-07-22T00:00:00.000Z",
    },
    occurredAt: "2026-07-22T00:00:00.000Z",
  });
  journal.append({
    id: "event-3",
    key: RunEvents.runtime.attached,
    payload: {
    mode: "start",
    attachedAt: "2026-07-22T00:00:00.000Z",
    processId: process.pid,
    },
    occurredAt: "2026-07-22T00:00:00.000Z",
  });
  journal.close();
  appendFileSync(journal.path, '{"version":1,"seq":4', "utf8");

  const reopened = Journal.open(location);
  t.after(() => reopened.close());
  assert.equal(reopened.lastSeq, 3);
  reopened.append({
    id: "event-4",
    key: RunEvents.runtime.detached,
    payload: { reason: "test", detachedAt: "2026-07-22T00:00:01.000Z" },
    occurredAt: "2026-07-22T00:00:01.000Z",
  });

  assert.equal(reopened.lastSeq, 4);
  assert.deepEqual(readJournalEvents(journal.path).map((event) => event.seq), [1, 2, 3, 4]);
});

test("Workflow Journal writer persists Human Input and delivery as separate events", async (t) => {
  const eventBus = new InMemoryEventBus();
  const { journal } = createTestRunPersistence(t, "journal-human-input", "/repo", eventBus);
  const requestMessage = {
    messageId: "task-1-human-1-request",
    agentId: "coordinator",
    body: agent.turn.wait_for_human_request("请确认目标版本。"),
    queuedAt: "2026-07-23T00:00:00.000Z",
  };
  await eventBus.publishAndWait(AgentEvents.humanInput.requested, {
    requestId: "task-1-human-1",
    taskId: "task-1",
    agentId: "researcher",
    body: "请确认目标版本。",
    requestedAt: requestMessage.queuedAt,
    message: requestMessage,
  });
  await eventBus.publishAndWait(AgentEvents.message.queued, requestMessage);

  const responseMessage = {
    messageId: "task-1-human-1-response",
    agentId: "researcher",
    taskId: "task-1",
    body: agent.turn.human_response({
      requestId: "task-1-human-1",
      taskId: "task-1",
      messageId: "task-1-human-1-response",
      response: "使用 v2。",
    }),
    queuedAt: "2026-07-23T00:01:00.000Z",
  };
  await eventBus.publishAndWait(AgentEvents.humanInput.responded, {
    requestId: "task-1-human-1",
    taskId: "task-1",
    agentId: "researcher",
    body: "使用 v2。",
    respondedAt: responseMessage.queuedAt,
    message: responseMessage,
  });
  await eventBus.publishAndWait(AgentEvents.message.queued, responseMessage);

  assert.deepEqual(
    journal.readAll().slice(2).map((event) => event.key.routeKey),
    [
      AgentEvents.humanInput.requested.routeKey,
      AgentEvents.message.queued.routeKey,
      AgentEvents.humanInput.responded.routeKey,
      AgentEvents.message.queued.routeKey,
    ],
  );
});

test("Workflow Journal writer persists thread identities without transient telemetry", async (t) => {
  const eventBus = new InMemoryEventBus();
  const { journal } = createTestRunPersistence(t, "journal-thread", "/repo", eventBus);
  const started = {
    agentId: "researcher",
    role: "researcher",
    phases: ["research"],
    contextBundleId: "context-1",
    threadId: "thread-researcher",
    createdAt: "2026-07-23T00:00:00.000Z",
    status: "active",
    startInput: {
      cwd: "/repo",
      approvalPolicy: "never",
      permissions: "scout-researcher",
      ephemeral: false,
    },
    startResponse: { thread: { id: "thread-researcher" } },
  } satisfies AgentThreadSnapshot;
  const restarted = {
    ...started,
    threadId: "thread-researcher-restarted",
    createdAt: "2026-07-23T00:01:00.000Z",
    startResponse: { thread: { id: "thread-researcher-restarted" } },
  } satisfies AgentThreadSnapshot;

  await eventBus.publishAndWait(AgentEvents.thread.started, started);
  await eventBus.publishAndWait(AgentEvents.thread.restarted, {
    previousThreadId: started.threadId,
    reason: "missing_rollout_without_recoverable_work",
    restartedAt: restarted.createdAt,
    newThread: restarted,
  });
  await eventBus.publishAndWait(AgentEvents.thread.resumed, {
    agentId: restarted.agentId,
    role: restarted.role,
    threadId: restarted.threadId,
    resumedAt: "2026-07-23T00:02:00.000Z",
    resumeInput: {
      threadId: restarted.threadId,
      excludeTurns: true,
      permissions: "scout-researcher",
    },
    resumeResponse: { thread: { id: restarted.threadId, turns: [] } },
  });
  await eventBus.publishAndWait(AgentEvents.thread.closed, {
    ...restarted,
    status: "closed",
    closedAt: "2026-07-23T00:03:00.000Z",
    closeReason: "test",
  });

  assert.deepEqual(
    journal.readAll().slice(2).map((event) => event.key.routeKey),
    [
      AgentEvents.thread.started.routeKey,
      AgentEvents.thread.restarted.routeKey,
    ],
  );
  const restartEvent = journal.readAll().find((event) =>
    AgentEvents.thread.restarted.is(event)
  );
  assert.ok(restartEvent && AgentEvents.thread.restarted.is(restartEvent));
  assert.deepEqual(restartEvent.payload, {
    previousThreadId: started.threadId,
    reason: "missing_rollout_without_recoverable_work",
    restartedAt: restarted.createdAt,
    newThread: restarted,
  });
});

test("Run projection replaces a thread only when restart names the current snapshot", async (t) => {
  const eventBus = new InMemoryEventBus();
  const { journal } = createTestRunPersistence(
    t,
    "journal-thread-restart-projection",
    "/repo",
    eventBus,
  );
  const started = {
    agentId: "validator",
    role: "validator",
    phases: ["research-reviewer"],
    contextBundleId: "context-validator-old",
    threadId: "thread-validator-old",
    createdAt: "2026-07-23T00:00:00.000Z",
    status: "active",
    startInput: {
      cwd: "/repo",
      approvalPolicy: "never",
      permissions: "scout-validator",
      ephemeral: false,
    },
    startResponse: { thread: { id: "thread-validator-old" } },
  } satisfies AgentThreadSnapshot;
  const restarted = {
    ...started,
    contextBundleId: "context-validator-new",
    threadId: "thread-validator-new",
    createdAt: "2026-07-23T00:01:00.000Z",
    startResponse: { thread: { id: "thread-validator-new" } },
  } satisfies AgentThreadSnapshot;

  await eventBus.publishAndWait(AgentEvents.thread.started, started);
  await eventBus.publishAndWait(AgentEvents.thread.restarted, {
    previousThreadId: started.threadId,
    reason: "missing_rollout_without_recoverable_work",
    restartedAt: restarted.createdAt,
    newThread: restarted,
  });

  assert.deepEqual(projectRun(journal.readAll()).threads, [restarted]);
});

test("Run projection rejects a restart whose previous thread is not current", async (t) => {
  const eventBus = new InMemoryEventBus();
  const { journal } = createTestRunPersistence(
    t,
    "journal-thread-restart-conflict",
    "/repo",
    eventBus,
  );
  const started = {
    agentId: "verifier",
    role: "verifier",
    phases: ["verify"],
    contextBundleId: "context-verifier",
    threadId: "thread-verifier-current",
    createdAt: "2026-07-23T00:00:00.000Z",
    status: "active",
    startInput: {
      cwd: "/repo",
      approvalPolicy: "never",
      permissions: "scout-verifier",
      ephemeral: false,
    },
    startResponse: { thread: { id: "thread-verifier-current" } },
  } satisfies AgentThreadSnapshot;

  await eventBus.publishAndWait(AgentEvents.thread.started, started);
  await eventBus.publishAndWait(AgentEvents.thread.restarted, {
    previousThreadId: "thread-verifier-stale",
    reason: "missing_rollout_without_recoverable_work",
    restartedAt: "2026-07-23T00:01:00.000Z",
    newThread: {
      ...started,
      threadId: "thread-verifier-new",
      createdAt: "2026-07-23T00:01:00.000Z",
      startResponse: { thread: { id: "thread-verifier-new" } },
    },
  });

  assert.throws(
    () => projectRun(journal.readAll()),
    /Thread restarted without matching previous thread: thread-verifier-stale/,
  );
});

test("JournalWriter retries the same event once after a transient write failure", async (t) => {
  const eventBus = new InMemoryEventBus();
  const { journal } = createCoreJournal(t, "journal-write-retry");
  const failures: unknown[] = [];
  const writer = new JournalWriter({
    eventBus,
    eventTypes: [RunEvents.runtime.attached],
    journal: () => journal,
    onFailure: (failure) => failures.push(failure),
  });
  writer.start();
  t.after(() => writer.stop());
  const append = journal.append.bind(journal);
  let attempts = 0;
  journal.append = (event) => {
    attempts += 1;
    if (attempts !== 1) return append(event);
    const restoreJournalPath = blockJournalWrites(journal.path);
    try {
      return append(event);
    } finally {
      restoreJournalPath();
    }
  };
  await eventBus.publishAndWait(RunEvents.runtime.attached, {
    mode: "start",
    attachedAt: "2026-07-23T00:00:00.000Z",
    processId: process.pid,
  });

  assert.equal(attempts, 2);
  assert.equal(journal.failed, false);
  assert.deepEqual(failures, []);
  assert.equal(journal.readAll().at(-1)?.key.routeKey, RunEvents.runtime.attached.routeKey);
});

test("Workflow Journal writer reports an unrecoverable event and accepts later writes", async (t) => {
  const eventBus = new InMemoryEventBus();
  const persistence = createTestRunPersistence(
    t,
    "journal-write-recovery",
    "/repo",
    eventBus,
  );
  const { journal, workflow } = persistence;
  installTestRunScope(t, {
    runId: journal.runId,
    eventBus,
    workflow,
    manifestStore: persistence.manifestStore,
  });
  const failures: RunJournalWriteFailedEvent[] = [];
  let downstreamDeliveries = 0;
  eventBus.subscribe<RunJournalWriteFailedEvent>(RunEvents.journal.writeFailed, (event) => {
    failures.push(event.payload);
  });
  eventBus.subscribe(RunEvents.runtime.attached, () => {
    downstreamDeliveries += 1;
  }, {
    priority: EventSubscriptionPriorities.Normal,
  });
  const restoreJournalPath = blockJournalWrites(journal.path);

  try {
    await eventBus.publishAndWait(RunEvents.runtime.attached, {
      mode: "start",
      attachedAt: "2026-07-23T00:00:00.000Z",
      processId: process.pid,
    });
  } finally {
    restoreJournalPath();
  }

  assert.equal(downstreamDeliveries, 1);
  assert.equal(workflow.journalFailed, true);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.failedEventKey, RunEvents.runtime.attached.routeKey);
  assert.equal(
    journal.readAll().some((event) => RunEvents.runtime.attached.is(event)),
    false,
  );

  await eventBus.publishAndWait(RunEvents.runtime.detached, {
    reason: "test",
    detachedAt: "2026-07-23T00:00:01.000Z",
  });

  assert.equal(workflow.journalFailed, false);
  assert.equal(
    journal.readAll().at(-1)?.key.routeKey,
    RunEvents.runtime.detached.routeKey,
  );
  assert.equal(
    journal.readAll().some((event) => RunEvents.journal.writeFailed.is(event)),
    false,
  );
});

test("Workflow starts a numbered Workflow while retaining the completed scout.journal", async (t) => {
  const eventBus = new InMemoryEventBus();
  const scoutRoot = mkdtempSync(join(tmpdir(), "scout-workflow-stage-test-"));
  const persistence = createTestRunPersistence(
    t,
    "journal-workflow-replay",
    scoutRoot,
    eventBus,
    join(scoutRoot, "run", "journal-workflow-replay"),
  );
  const benchmarks = new ScoutBenchmarks(new Benchmarks(persistence.runRoot));
  const scope = installTestRunScope(t, {
    runId: persistence.journal.runId,
    eventBus,
    workflow: persistence.workflow,
    manifestStore: persistence.manifestStore,
    scoutRoot,
  });
  baseDomain(scope).start();
  t.after(() => baseDomain(scope).close());
  t.after(() => rmSync(scoutRoot, { recursive: true, force: true }));
  await eventBus.publishAndWait(RunEvents.runtime.attached, {
    mode: "start",
    attachedAt: "2026-07-24T00:00:00.000Z",
    processId: process.pid,
  });
  persistence.workflow.scheduler.advance("completed");
  persistence.workflow.scheduler.advance("completed");
  persistence.workflow.scheduler.advance("completed");
  const completed = persistence.workflow.scheduler.advance("completed");
  assert.equal(completed.cycleCompleted, true);
  assert.equal(persistence.workflow.snapshot()?.status, "settling");
  assert.ok(persistence.journal.readAll().some((event) =>
    WorkflowEvents.workflow.advanced.is(event)
  ));
  const completedJournalPath = persistence.journal.path;

  await persistence.workflow.settleWorkflow();
  assert.equal(persistence.workflow.snapshot(), undefined);
  await persistence.workflow.startWorkflow();
  await eventBus.publishAndWait(SystemEvents.interaction.userMessageSubmitted, {
    messageId: "workflow-replay-message",
    text: "重新执行",
    attachment: agent.turn.message("重新执行"),
    submittedAt: "2026-07-24T00:01:00.000Z",
  });

  const events = scope.workflow.readEvents();
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
  assert.deepEqual(events.map((event) => event.key.routeKey), [
    RunEvents.run.created.routeKey,
    WorkflowEvents.workflow.initialized.routeKey,
    SystemEvents.interaction.userMessageSubmitted.routeKey,
  ]);
  assert.equal(events.some((event) => WorkflowEvents.workflow.advanced.is(event)), false);
  assert.ok(readJournalEvents(completedJournalPath).some((event) =>
    WorkflowEvents.workflow.advanced.is(event)
  ));
  assert.equal(readJournalEvents(completedJournalPath).filter((event) =>
    WorkflowEvents.workflow.completed.is(event)
  ).length, 1);
  assert.equal(benchmarks.read()?.currentWorkflow, "workflow-002");
  assert.equal(persistence.manifestStore.read().checkpointSeq, 2);
  assert.equal(Object.hasOwn(persistence.manifestStore.read(), "workflowId"), false);
  assert.throws(
    () => Journal.open(scoutJournalLocation(scope.runId, scope.workflow.journalRoot)),
    /already attached/,
  );
});

test("Workflow blocks replay while a settling Workflow retains a Task", async (t) => {
  const eventBus = new InMemoryEventBus();
  const persistence = createTestRunPersistence(
    t,
    "journal-workflow-replay-blocked",
    "/repo",
    eventBus,
  );
  const scope = installTestRunScope(t, {
    runId: persistence.journal.runId,
    eventBus,
    workflow: persistence.workflow,
    manifestStore: persistence.manifestStore,
  });
  baseDomain(scope).start();
  t.after(() => baseDomain(scope).close());
  await eventBus.publishAndWait(RunEvents.runtime.attached, {
    mode: "start",
    attachedAt: "2026-07-24T00:00:00.000Z",
    processId: process.pid,
  });
  await eventBus.publishAndWait(AgentEvents.task.assigned, {
    taskId: "researcher-task-0001",
    taskSequence: 1,
    agentId: "researcher",
    role: "researcher",
    phase: "research",
    description: "unfinished",
    initialPrompt: "unfinished",
    status: "queued",
    stepIds: [],
    dispositions: [],
    protocolRepairAttempts: 0,
    createdAt: "2026-07-24T00:00:01.000Z",
    updatedAt: "2026-07-24T00:00:01.000Z",
  });
  persistence.workflow.scheduler.advance("completed");
  persistence.workflow.scheduler.advance("completed");
  persistence.workflow.scheduler.advance("completed");
  persistence.workflow.scheduler.advance("completed");
  assert.equal(persistence.workflow.snapshot()?.status, "settling");

  await assert.rejects(
    persistence.workflow.settleWorkflow(),
    /unfinished Task researcher-task-0001/,
  );
  assert.equal(persistence.workflow.snapshot()?.status, "settling");
  assert.equal(persistence.journal.readAll().some((event) => WorkflowEvents.workflow.completed.is(event)), false);
  await assert.rejects(eventBus.publishAndWait(SystemEvents.interaction.userMessageSubmitted, {
    messageId: "workflow-replay-blocked-message",
    text: "重新执行",
    attachment: agent.turn.message("重新执行"),
    submittedAt: "2026-07-24T00:01:00.000Z",
  }), /not ready to accept input/);
  assert.equal(
    persistence.journal.readAll().some((event) =>
      SystemEvents.interaction.userMessageSubmitted.is(event)
      && event.payload.messageId === "workflow-replay-blocked-message"
    ),
    false,
  );
});

test("Journal rejects a malformed complete event", (t) => {
  const { journal, location } = createCoreJournal(t, "journal-malformed");
  journal.close();
  appendFileSync(journal.path, "not-json\n", "utf8");

  assert.throws(
    () => Journal.open(location),
    /Invalid journal JSON/,
  );
});

function blockJournalWrites(path: string): () => void {
  const backupPath = `${path}.writable`;
  renameSync(path, backupPath);
  mkdirSync(path);
  return () => {
    rmSync(path, { recursive: true, force: true });
    renameSync(backupPath, path);
  };
}

function scoutJournalLocation(runId: string, journalRoot: string): JournalLocation {
  return {
    journalId: `${runId}:workflow:scout`,
    path: join(journalRoot, "scout.journal"),
    lockPath: join(journalRoot, ".scout.lock"),
  };
}

function createCoreJournal(
  t: TestContext,
  journalId: string,
): { journal: Journal; location: JournalLocation } {
  const root = mkdtempSync(join(tmpdir(), "scout-core-journal-test-"));
  const location = {
    journalId,
    path: join(root, "events.journal"),
    lockPath: join(root, ".events.lock"),
  };
  const journal = Journal.create(location);
  t.after(() => {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { journal, location };
}
