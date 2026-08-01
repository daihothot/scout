import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ScoutAgent } from "../../src/agent/core/scout-agent.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import { TaskEventRecorder } from "../../src/agent/telemetry/task-event-recorder.js";
import { AgentTaskStore } from "../../src/agent/task/agent-task-store.js";
import {
  AgentTaskDispositionKinds,
  AgentTaskStatuses,
  AgentTaskStepStatuses,
  type AgentTaskDisposition,
  type AgentTaskState,
} from "../../src/agent/task/types.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { projectRun } from "../../src/run/resume/projection/run-projector.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("AgentTaskStore records each disposition kind and rejects a conflicting step disposition", () => {
  const dispositions: AgentTaskDisposition[] = [
    {
      kind: AgentTaskDispositionKinds.HandoffSubmitted,
      stepId: "task-handoff-step-0001",
      turnId: "turn-handoff",
      callId: "call-handoff",
      timestamp: "2026-08-01T00:00:01.000Z",
      outcome: "## Outcome\n\n完成。",
    },
    {
      kind: AgentTaskDispositionKinds.WaitingForHuman,
      stepId: "task-human-step-0001",
      turnId: "turn-human",
      callId: "call-human",
      requestId: "request-human",
      request: "请选择目标账号。",
      timestamp: "2026-08-01T00:00:02.000Z",
    },
    {
      kind: AgentTaskDispositionKinds.ProtocolViolation,
      stepId: "task-protocol-step-0001",
      turnId: "turn-protocol",
      callId: null,
      timestamp: "2026-08-01T00:00:03.000Z",
      reason: "Worker turn completed without a lifecycle disposition.",
    },
  ];
  const store = new AgentTaskStore();

  for (const disposition of dispositions) {
    const taskId = disposition.stepId.replace(/-step-0001$/, "");
    store.addTask(taskState(taskId, disposition.stepId, disposition.turnId));
    const updated = store.recordTaskDisposition(taskId, disposition);
    assert.deepEqual(updated.steps?.[0]?.disposition, disposition);
    assert.equal(updated.updatedAt, disposition.timestamp);
  }

  const handoff = dispositions[0];
  if (!handoff || handoff.kind !== AgentTaskDispositionKinds.HandoffSubmitted) {
    throw new Error("Expected a handoff disposition fixture.");
  }
  const retried = store.recordTaskDisposition("task-handoff", {
    ...handoff,
    timestamp: "2026-08-01T00:00:04.000Z",
  });
  assert.equal(retried.steps?.[0]?.disposition?.timestamp, handoff.timestamp);
  const callerSnapshot = store.getTask("task-handoff");
  const callerDisposition = callerSnapshot?.steps?.[0]?.disposition;
  if (callerDisposition?.kind !== AgentTaskDispositionKinds.HandoffSubmitted) {
    throw new Error("Expected the stored handoff disposition.");
  }
  callerDisposition.outcome = "mutated outside the store";
  const storedDisposition = store.getTask("task-handoff")?.steps?.[0]?.disposition;
  assert.equal(
    storedDisposition?.kind === AgentTaskDispositionKinds.HandoffSubmitted
      ? storedDisposition.outcome
      : undefined,
    handoff.outcome,
  );
  assert.throws(
    () => store.recordTaskDisposition("task-handoff", {
      kind: AgentTaskDispositionKinds.WaitingForHuman,
      stepId: handoff.stepId,
      turnId: handoff.turnId,
      callId: "call-conflict",
      requestId: "request-conflict",
      request: "请确认冲突输入。",
      timestamp: "2026-08-01T00:00:05.000Z",
    }),
    /already has a different disposition/,
  );
});

test("disposition events persist, restore task state, and write task telemetry", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-task-disposition-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logsRoot = join(root, "agents", "researcher", "logs");
  const eventBus = new InMemoryEventBus();
  const scope = installTestRunScope(t, {
    runId: "run-task-disposition",
    eventBus,
  });
  scope.agentRegistry.registerAgent({
    agentId: ScoutAgentRoles.Researcher,
    get mount() {
      return { logsRoot };
    },
  } as ScoutAgent);
  const recorder = new TaskEventRecorder();
  recorder.start();
  t.after(() => recorder.stop());

  const task = scope.taskStore.addTask(taskState(
    "researcher-task-0001",
    "researcher-task-0001-step-0001",
    "turn-1",
  ));
  await eventBus.publishAndWait(AgentEvents.task.assigned, task);
  const disposition = {
    kind: AgentTaskDispositionKinds.HandoffSubmitted,
    stepId: "researcher-task-0001-step-0001",
    turnId: "turn-1",
    callId: "call-submit-1",
    timestamp: "2026-08-01T00:01:00.000Z",
    outcome: "## Outcome\n\n- artifact: result.md",
  } satisfies AgentTaskDisposition;
  const disposedTask = scope.taskStore.recordTaskDisposition(task.taskId, disposition);
  await eventBus.publishAndWait(AgentEvents.task.dispositionRecorded, {
    task: disposedTask,
    disposition,
  }, {
    occurredAt: disposition.timestamp,
  });

  assert.equal(
    scope.journal.readAll().at(-1)?.key.routeKey,
    AgentEvents.task.dispositionRecorded.routeKey,
  );
  const projection = projectRun(scope.journal.readAll());
  assert.deepEqual(projection.tasks[0]?.steps?.[0]?.disposition, disposition);

  const submittedAt = "2026-08-01T00:01:01.000Z";
  await eventBus.publishAndWait(AgentEvents.task.outcomeSubmitted, {
    task: {
      ...disposedTask,
      status: AgentTaskStatuses.Done,
      updatedAt: submittedAt,
    },
    stepId: disposition.stepId,
    turnId: disposition.turnId,
    callId: disposition.callId,
    outcome: disposition.outcome,
    submittedAt,
  }, {
    occurredAt: submittedAt,
  });
  recorder.stop();

  const taskLogPath = join(logsRoot, `${task.taskId}.log`);
  assert.equal(existsSync(taskLogPath), true);
  const text = readFileSync(taskLogPath, "utf8");
  assert.match(text, /event=agent\.task\.disposition_recorded/);
  assert.match(text, /kind: "handoff_submitted"/);
  assert.match(text, /turnId: "turn-1"/);
  assert.match(text, /callId: "call-submit-1"/);
  assert.match(text, /timestamp: "2026-08-01T00:01:00\.000Z"/);
  assert.match(text, /event=agent\.task\.outcome_submitted/);
  assert.match(text, /submittedAt: "2026-08-01T00:01:01\.000Z"/);
  assert.match(text, /artifact: result\.md/);
  const outcomeRecord = text.slice(text.indexOf("event=agent.task.outcome_submitted"));
  assert.match(outcomeRecord, /stepId: "researcher-task-0001-step-0001"/);
  assert.match(outcomeRecord, /turnId: "turn-1"/);
  assert.match(outcomeRecord, /callId: "call-submit-1"/);
});

function taskState(taskId: string, stepId: string, turnId: string): AgentTaskState {
  return {
    type: "local_agent",
    taskId,
    taskSequence: 1,
    agentId: ScoutAgentRoles.Researcher,
    role: ScoutAgentRoles.Researcher,
    description: "Record a Worker disposition",
    initialPrompt: "Record a Worker disposition",
    status: AgentTaskStatuses.Running,
    isBackgrounded: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    startedAt: "2026-08-01T00:00:00.000Z",
    steps: [{
      stepId,
      taskId,
      turnId,
      status: AgentTaskStepStatuses.Running,
      prompt: "Perform the current task.",
      toolCalls: [],
      startedAt: "2026-08-01T00:00:00.000Z",
      requiresDisposition: true,
    }],
  };
}
