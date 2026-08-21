import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  AgentStepStore,
  type AgentStepState,
} from "../../src/agent/step/index.js";

function step(): AgentStepState {
  return {
    stepId: "researcher-step-0001",
    agentId: "researcher",
    taskId: "researcher-task-0001",
    status: "running",
    prompt: "inspect",
    toolCalls: [],
    startedAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

test("AgentStepStore owns Step facts and returns detached updates", () => {
  const store = new AgentStepStore();
  store.addStep(step());
  const updated = store.updateStep(step().stepId, (current) => ({
    ...current,
    turnId: "turn-1",
    toolCalls: [{
      namespace: "scout",
      tool: "SubmitTask",
      callId: "call-1",
      success: true,
    }],
    updatedAt: "2026-08-20T00:00:01.000Z",
  }));
  assert.equal(updated.turnId, "turn-1");
  assert.equal(updated.toolCalls[0]?.tool, "SubmitTask");

  updated.toolCalls.push({ namespace: null, tool: "mutated" });
  assert.equal(store.getStep(step().stepId)?.toolCalls.length, 1);
});

test("AgentStepStore returns detached snapshots", () => {
  const store = new AgentStepStore();
  store.addStep(step());
  const snapshot = store.getStep(step().stepId)!;
  snapshot.toolCalls.push({ namespace: null, tool: "mutated" });
  assert.equal(store.getStep(step().stepId)?.toolCalls.length, 0);
});

test("AgentStepStore restores one step without clearing other agents", () => {
  const store = new AgentStepStore();
  store.addStep(step());
  const coordinatorStep: AgentStepState = {
    ...step(),
    stepId: "coordinator-step-0001",
    agentId: "coordinator",
    taskId: undefined,
  };
  store.restoreStep(coordinatorStep);
  assert.deepEqual(
    store.list().map((candidate) => candidate.stepId).sort(),
    ["coordinator-step-0001", "researcher-step-0001"],
  );
  const restored = store.restoreStep(coordinatorStep);
  assert.equal(restored.stepId, coordinatorStep.stepId);
  assert.equal(restored.agentId, coordinatorStep.agentId);
  assert.equal(restored.status, coordinatorStep.status);
  assert.equal(restored.prompt, coordinatorStep.prompt);
  assert.throws(() => store.restoreStep({
    ...coordinatorStep,
    agentId: "validator",
  }));
});

test("Agent runners do not depend on AgentStepBackend", () => {
  const runnerSources = [
    "src/agent/runner/agent-runner.ts",
    "src/agent/runner/coordinator/coordinator-runner.ts",
    "src/agent/runner/task/task-runner.ts",
    "src/agent/runner/worker/worker-runner.ts",
  ];
  for (const sourcePath of runnerSources) {
    const source = readFileSync(join(process.cwd(), sourcePath), "utf8");
    assert.doesNotMatch(source, /AgentStepBackend|agent-step-backend|stepBackend/);
  }
});

test("WorkerRunner owns Step facts while TaskRunner owns Task facts", () => {
  const workerSource = readFileSync(
    join(process.cwd(), "src/agent/runner/worker/worker-runner.ts"),
    "utf8",
  );
  const taskSource = readFileSync(
    join(process.cwd(), "src/agent/runner/task/task-runner.ts"),
    "utf8",
  );

  assert.doesNotMatch(workerSource, /AgentEvents\.task|taskStore|AgentTaskDisposition|AgentTaskStatus/);
  assert.doesNotMatch(taskSource, /AgentEvents\.step|stepStore\.(?:add|update)|\.(?:start|complete|interrupt|fail)Step\(/);
  assert.doesNotMatch(taskSource, /WorkerRunner|worker-runner/);
});
