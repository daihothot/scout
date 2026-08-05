import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agent } from "../../src/agent/context/agent-attachments.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import {
  ScoutAgentPhases,
  ScoutAgentRoles,
  type AgentThreadSnapshot,
} from "../../src/agent/thread/types.js";
import {
  EventSubscriptionPriorities,
  InMemoryEventBus,
} from "../../src/core/events/index.js";
import {
  RunJournal,
  RunJournalWriter,
  readJournalEvents,
} from "../../src/run/journal/index.js";
import {
  RunEvents,
  type RunJournalWriteFailedEvent,
} from "../../src/run/events/index.js";
import {
  createTestRunPersistence,
  installTestRunScope,
} from "../helpers/run-persistence.js";

test("RunJournalWriter persists monotonic EventBus events and holds one runtime lock", async (t) => {
  const eventBus = new InMemoryEventBus();
  const { journal } = createTestRunPersistence(t, "journal-sequence", "/repo", eventBus);
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

  assert.equal(journal.readAll()[1]?.key.routeKey, RunEvents.runtime.attached.routeKey);
  assert.equal(journal.readAll()[2]?.key.routeKey, RunEvents.runtime.ready.routeKey);
  assert.deepEqual(journal.readAll().map((event) => event.seq), [1, 2, 3]);
  assert.throws(
    () => RunJournal.open({ runId: journal.runId, runRoot: journal.runRoot }),
    /already attached/,
  );
  const lockPath = join(journal.runRoot, ".run.lock");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { hostId: string };
  assert.equal(lock.hostId, hostname());
  journal.close();
  assert.equal(existsSync(lockPath), false);
});

test("RunJournal replaces a stale lock only when it belongs to the current host", (t) => {
  const { journal } = createTestRunPersistence(t, "journal-stale-local-lock");
  const lockPath = join(journal.runRoot, ".run.lock");
  journal.close();
  writeFileSync(lockPath, `${JSON.stringify({
    runId: journal.runId,
    hostId: hostname(),
    processId: 2_147_483_647,
    token: "stale-local-token",
    acquiredAt: "2026-07-22T00:00:00.000Z",
  })}\n`, "utf8");

  const reopened = RunJournal.open({ runId: journal.runId, runRoot: journal.runRoot });
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

test("RunJournal preserves and rejects a foreign-host lock", (t) => {
  const { journal } = createTestRunPersistence(t, "journal-foreign-lock");
  const lockPath = join(journal.runRoot, ".run.lock");
  journal.close();
  const foreignLock = `${JSON.stringify({
    runId: journal.runId,
    hostId: `${hostname()}-foreign`,
    processId: process.pid,
    token: "foreign-token",
    acquiredAt: "2026-07-22T00:00:00.000Z",
  })}\n`;
  writeFileSync(lockPath, foreignLock, "utf8");

  assert.throws(
    () => RunJournal.open({ runId: journal.runId, runRoot: journal.runRoot }),
    /locked by host .*foreign.*current host/,
  );
  assert.equal(readFileSync(lockPath, "utf8"), foreignLock);
});

test("RunJournal repairs an incomplete tail before the next EventBus append", async (t) => {
  const eventBus = new InMemoryEventBus();
  const { journal, manifestStore } = createTestRunPersistence(
    t,
    "journal-tail",
    "/repo",
    eventBus,
  );
  await eventBus.publishAndWait(RunEvents.runtime.ready, {
    mode: "start",
    readyAt: "2026-07-22T00:00:00.000Z",
  }, {
    occurredAt: "2026-07-22T00:00:00.000Z",
  });
  journal.close();
  appendFileSync(journal.path, '{"version":1,"seq":3', "utf8");

  const reopened = RunJournal.open({ runId: journal.runId, runRoot: journal.runRoot });
  t.after(() => reopened.close());
  assert.equal(reopened.lastSeq, 2);
  const reopenedBus = new InMemoryEventBus();
  installTestRunScope(t, {
    runId: reopened.runId,
    eventBus: reopenedBus,
    journal: reopened,
    manifestStore,
  });
  const writer = new RunJournalWriter();
  writer.start();
  t.after(() => writer.stop());
  await reopenedBus.publishAndWait(RunEvents.runtime.detached, {
    reason: "test",
    detachedAt: "2026-07-22T00:00:01.000Z",
  }, {
    occurredAt: "2026-07-22T00:00:01.000Z",
  });

  assert.equal(reopened.lastSeq, 3);
  assert.deepEqual(readJournalEvents(journal.path).map((event) => event.seq), [1, 2, 3]);
});

test("RunJournalWriter persists Human Input semantics and message delivery as separate events", async (t) => {
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
    body: agent.turn.human_response("使用 v2。"),
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
    journal.readAll().slice(1).map((event) => event.key.routeKey),
    [
      AgentEvents.humanInput.requested.routeKey,
      AgentEvents.message.queued.routeKey,
      AgentEvents.humanInput.responded.routeKey,
      AgentEvents.message.queued.routeKey,
    ],
  );
});

test("RunJournalWriter persists thread start, resume and close lifecycle facts", async (t) => {
  const eventBus = new InMemoryEventBus();
  const { journal } = createTestRunPersistence(t, "journal-thread", "/repo", eventBus);
  const started = {
    agentId: ScoutAgentRoles.Researcher,
    role: ScoutAgentRoles.Researcher,
    phases: [ScoutAgentPhases.Research],
    contextBundleId: "context-1",
    threadId: "thread-researcher",
    createdAt: "2026-07-23T00:00:00.000Z",
    status: "active",
    startInput: {
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: false,
    },
    startResponse: { thread: { id: "thread-researcher" } },
  } satisfies AgentThreadSnapshot;

  await eventBus.publishAndWait(AgentEvents.thread.started, started);
  await eventBus.publishAndWait(AgentEvents.thread.resumed, {
    agentId: started.agentId,
    role: started.role,
    threadId: started.threadId,
    resumedAt: "2026-07-23T00:01:00.000Z",
    resumeInput: {
      threadId: started.threadId,
      excludeTurns: true,
    },
    resumeResponse: { thread: { id: started.threadId, turns: [] } },
  });
  await eventBus.publishAndWait(AgentEvents.thread.closed, {
    ...started,
    status: "closed",
    closedAt: "2026-07-23T00:02:00.000Z",
    closeReason: "test",
  });

  assert.deepEqual(
    journal.readAll().slice(1).map((event) => event.key.routeKey),
    [
      AgentEvents.thread.started.routeKey,
      AgentEvents.thread.resumed.routeKey,
      AgentEvents.thread.closed.routeKey,
    ],
  );
});

test("RunJournalWriter retries the same event once after a transient write failure", async (t) => {
  const eventBus = new InMemoryEventBus();
  const { journal } = createTestRunPersistence(t, "journal-write-retry", "/repo", eventBus);
  const failures: RunJournalWriteFailedEvent[] = [];
  eventBus.subscribe<RunJournalWriteFailedEvent>(RunEvents.journal.writeFailed, (event) => {
    failures.push(event.payload);
  });
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

  await eventBus.publishAndWait(RunEvents.runtime.ready, {
    mode: "start",
    readyAt: "2026-07-23T00:00:00.000Z",
  });

  assert.equal(attempts, 2);
  assert.equal(journal.failed, false);
  assert.deepEqual(failures, []);
  assert.equal(journal.readAll().at(-1)?.key.routeKey, RunEvents.runtime.ready.routeKey);
});

test("RunJournalWriter drops an unrecoverable event without blocking later dispatch or writes", async (t) => {
  const eventBus = new InMemoryEventBus();
  const { journal } = createTestRunPersistence(
    t,
    "journal-write-recovery",
    "/repo",
    eventBus,
  );
  const failures: RunJournalWriteFailedEvent[] = [];
  let downstreamDeliveries = 0;
  eventBus.subscribe<RunJournalWriteFailedEvent>(RunEvents.journal.writeFailed, (event) => {
    failures.push(event.payload);
  });
  eventBus.subscribe(RunEvents.runtime.ready, () => {
    downstreamDeliveries += 1;
  }, {
    priority: EventSubscriptionPriorities.Normal,
  });
  const restoreJournalPath = blockJournalWrites(journal.path);

  try {
    await eventBus.publishAndWait(RunEvents.runtime.ready, {
      mode: "start",
      readyAt: "2026-07-23T00:00:00.000Z",
    });
  } finally {
    restoreJournalPath();
  }

  assert.equal(downstreamDeliveries, 1);
  assert.equal(journal.failed, true);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.failedEventKey, RunEvents.runtime.ready.routeKey);
  assert.equal(
    journal.readAll().some((event) => RunEvents.runtime.ready.is(event)),
    false,
  );

  await eventBus.publishAndWait(RunEvents.runtime.detached, {
    reason: "test",
    detachedAt: "2026-07-23T00:00:01.000Z",
  });

  assert.equal(journal.failed, false);
  assert.equal(
    journal.readAll().at(-1)?.key.routeKey,
    RunEvents.runtime.detached.routeKey,
  );
  assert.equal(
    journal.readAll().some((event) => RunEvents.journal.writeFailed.is(event)),
    false,
  );
});

test("RunJournal rejects a malformed complete event", (t) => {
  const { journal } = createTestRunPersistence(t, "journal-malformed");
  journal.close();
  appendFileSync(journal.path, "not-json\n", "utf8");

  assert.throws(
    () => RunJournal.open({ runId: journal.runId, runRoot: journal.runRoot }),
    /Invalid run journal JSON/,
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
