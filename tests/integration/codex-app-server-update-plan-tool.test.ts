import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAppServerClient,
  type JsonRpcNotification,
} from "../../src/agent-server/codex/app-server-client.js";
import { AppServerTimelineStreams } from "../../src/agent-server/codex/app-server-event-store.js";

const enabled = process.env.SCOUT_RUN_CODEX_APP_SERVER_INTEGRATION === "1"
  && process.env.SCOUT_RUN_CODEX_UPDATE_PLAN_TOOL_EXPERIMENT === "1";
const codexPath = join(process.cwd(), "node_modules", ".bin", "codex");

test("real Codex app-server emits turn plan updates from update_plan tool", {
  skip: enabled
    ? undefined
    : "set SCOUT_RUN_CODEX_APP_SERVER_INTEGRATION=1 and SCOUT_RUN_CODEX_UPDATE_PLAN_TOOL_EXPERIMENT=1",
  timeout: 180_000,
}, async (context) => {
  const root = mkdtempSync(join(tmpdir(), "scout-update-plan-tool-experiment-"));
  const userHome = process.env.HOME ?? root;
  const codexHome = process.env.CODEX_HOME ?? join(userHome, ".codex");
  if (!existsSync(codexHome)) {
    throw new Error(`Codex home does not exist: ${codexHome}`);
  }

  const client = new CodexAppServerClient({
    codexPath,
    home: userHome,
    codexHome,
    logPrefix: "scout update-plan-tool experiment app-server",
  });
  const rawPlanUpdates: RawTurnPlanUpdate[] = [];
  client.onNotification((notification) => {
    const update = rawTurnPlanUpdate(notification);
    if (update) {
      rawPlanUpdates.push(update);
      context.diagnostic(`turn/plan/updated #${rawPlanUpdates.length}:\n${JSON.stringify(update, null, 2)}`);
    }
  });

  try {
    await client.startSession();
    const thread = await client.startThread({
      cwd: root,
      approvalPolicy: "never",
      permissions: ":read-only",
      baseInstructions: [
        "You are a Scout integration test agent.",
        "Do not run shell commands, read files, write files, or call external tools.",
        "Before the final answer, you must call the built-in update_plan tool three times.",
        "Each time you complete one step, call update_plan immediately.",
        "Every update_plan call must contain the same three steps in the same order:",
        "1. SCOUT_UPDATE_PLAN_STEP_ONE",
        "2. SCOUT_UPDATE_PLAN_STEP_TWO",
        "3. SCOUT_UPDATE_PLAN_STEP_THREE",
        "First update_plan call: explanation SCOUT_UPDATE_PLAN_EXPLANATION_1, statuses completed, in_progress, pending.",
        "Second update_plan call: explanation SCOUT_UPDATE_PLAN_EXPLANATION_2, statuses completed, completed, in_progress.",
        "Third update_plan call: explanation SCOUT_UPDATE_PLAN_EXPLANATION_3, statuses completed, completed, completed.",
        "After the third update_plan call succeeds, final answer must be exactly SCOUT_UPDATE_PLAN_DONE.",
      ].join("\n"),
      developerInstructions: [
        "You must call update_plan after completing each step before the final answer.",
      ].join("\n"),
      config: {
        model_reasoning_effort: "medium",
      },
    });

    const beforeSeq = client.currentTimelineSeq();
    const turn = await client.runTurn({
      threadId: thread.threadId,
      prompt: [
        "Complete the three Scout update_plan steps.",
        "Call update_plan immediately after each step is completed.",
        "Then answer only SCOUT_UPDATE_PLAN_DONE.",
      ].join("\n"),
      timeoutMs: 120_000,
      permissions: ":read-only",
    });
    const planEntries = client.timelineSince(beforeSeq, {
      threadId: thread.threadId,
      stream: AppServerTimelineStreams.Plan,
    });
    const report = updatePlanReport({
      finalResponse: turn.finalResponse,
      rawPlanUpdates,
      timelineKinds: planEntries.map((entry) => entry.kind),
      plan: turn.plan,
    });

    assert.match(turn.finalResponse, /SCOUT_UPDATE_PLAN_DONE/, report);
    assert.equal(rawPlanUpdates.length, 3, report);
    assert.deepEqual(rawPlanUpdates[0], {
      threadId: rawPlanUpdates[0]?.threadId,
      turnId: rawPlanUpdates[0]?.turnId,
      explanation: "SCOUT_UPDATE_PLAN_EXPLANATION_1",
      steps: [
        { step: "SCOUT_UPDATE_PLAN_STEP_ONE", status: "completed" },
        { step: "SCOUT_UPDATE_PLAN_STEP_TWO", status: "inProgress" },
        { step: "SCOUT_UPDATE_PLAN_STEP_THREE", status: "pending" },
      ],
    }, report);
    assert.deepEqual(rawPlanUpdates[1], {
      threadId: rawPlanUpdates[1]?.threadId,
      turnId: rawPlanUpdates[1]?.turnId,
      explanation: "SCOUT_UPDATE_PLAN_EXPLANATION_2",
      steps: [
        { step: "SCOUT_UPDATE_PLAN_STEP_ONE", status: "completed" },
        { step: "SCOUT_UPDATE_PLAN_STEP_TWO", status: "completed" },
        { step: "SCOUT_UPDATE_PLAN_STEP_THREE", status: "inProgress" },
      ],
    }, report);
    assert.deepEqual(rawPlanUpdates[2], {
      threadId: rawPlanUpdates[2]?.threadId,
      turnId: rawPlanUpdates[2]?.turnId,
      explanation: "SCOUT_UPDATE_PLAN_EXPLANATION_3",
      steps: [
        { step: "SCOUT_UPDATE_PLAN_STEP_ONE", status: "completed" },
        { step: "SCOUT_UPDATE_PLAN_STEP_TWO", status: "completed" },
        { step: "SCOUT_UPDATE_PLAN_STEP_THREE", status: "completed" },
      ],
    }, report);
    assert.deepEqual(turn.plan?.steps.map((step) => ({
      step: step.step,
      status: step.status,
    })), [
      { step: "SCOUT_UPDATE_PLAN_STEP_ONE", status: "completed" },
      { step: "SCOUT_UPDATE_PLAN_STEP_TWO", status: "completed" },
      { step: "SCOUT_UPDATE_PLAN_STEP_THREE", status: "completed" },
    ], report);
    assert.ok(planEntries.some((entry) => entry.kind === "plan_updated"), report);
    assert.equal(turn.plan?.steps.length, 3, report);
  } finally {
    client.close();
  }
});

test("real Codex app-server preserves update_plan state across turns", {
  skip: enabled
    ? undefined
    : "set SCOUT_RUN_CODEX_APP_SERVER_INTEGRATION=1 and SCOUT_RUN_CODEX_UPDATE_PLAN_TOOL_EXPERIMENT=1",
  timeout: 240_000,
}, async (context) => {
  const root = mkdtempSync(join(tmpdir(), "scout-update-plan-multi-turn-experiment-"));
  const userHome = process.env.HOME ?? root;
  const codexHome = process.env.CODEX_HOME ?? join(userHome, ".codex");
  if (!existsSync(codexHome)) {
    throw new Error(`Codex home does not exist: ${codexHome}`);
  }

  const client = new CodexAppServerClient({
    codexPath,
    home: userHome,
    codexHome,
    logPrefix: "scout update-plan multi-turn experiment app-server",
  });
  const rawPlanUpdates: RawTurnPlanUpdate[] = [];
  client.onNotification((notification) => {
    const update = rawTurnPlanUpdate(notification);
    if (update) {
      rawPlanUpdates.push(update);
      context.diagnostic(`multi-turn turn/plan/updated #${rawPlanUpdates.length}:\n${JSON.stringify(update, null, 2)}`);
    }
  });

  try {
    await client.startSession();
    const thread = await client.startThread({
      cwd: root,
      approvalPolicy: "never",
      permissions: ":read-only",
      baseInstructions: [
        "You are a Scout multi-turn update_plan integration test agent.",
        "Do not run shell commands, read files, write files, or call external tools.",
        "This thread has exactly three steps in this order:",
        "1. SCOUT_MULTI_TURN_STEP_ONE",
        "2. SCOUT_MULTI_TURN_STEP_TWO",
        "3. SCOUT_MULTI_TURN_STEP_THREE",
        "Whenever a step is completed, immediately call the built-in update_plan tool.",
        "Every update_plan call must contain the same three steps in the same order.",
        "Turn 1 may only complete step one, then it must stop with final answer SCOUT_MULTI_TURN_DONE_1.",
        "Turn 2 may only complete step two, then it must stop with final answer SCOUT_MULTI_TURN_DONE_2.",
        "Turn 3 must complete step three, then it must stop with final answer SCOUT_MULTI_TURN_DONE_3.",
      ].join("\n"),
      developerInstructions: [
        "Do not complete future-turn steps early.",
        "Call update_plan exactly once in each turn, immediately after that turn's step is completed.",
      ].join("\n"),
      config: {
        model_reasoning_effort: "medium",
      },
    });

    const beforeSeq = client.currentTimelineSeq();
    const turn1 = await client.runTurn({
      threadId: thread.threadId,
      prompt: [
        "Turn 1: complete only SCOUT_MULTI_TURN_STEP_ONE.",
        "Call update_plan with explanation SCOUT_MULTI_TURN_EXPLANATION_1 and statuses completed, in_progress, pending.",
        "You are blocked before completing step two in this turn.",
        "After update_plan, answer exactly SCOUT_MULTI_TURN_DONE_1.",
      ].join("\n"),
      timeoutMs: 120_000,
      permissions: ":read-only",
    });
    assert.match(turn1.finalResponse, /SCOUT_MULTI_TURN_DONE_1/, updatePlanReport({
      finalResponse: turn1.finalResponse,
      rawPlanUpdates,
      timelineKinds: [],
      plan: turn1.plan,
    }));

    const turn2 = await client.runTurn({
      threadId: thread.threadId,
      prompt: [
        "Turn 2: continue from the existing plan and complete only SCOUT_MULTI_TURN_STEP_TWO.",
        "Call update_plan with explanation SCOUT_MULTI_TURN_EXPLANATION_2 and statuses completed, completed, in_progress.",
        "You are blocked before completing step three in this turn.",
        "After update_plan, answer exactly SCOUT_MULTI_TURN_DONE_2.",
      ].join("\n"),
      timeoutMs: 120_000,
      permissions: ":read-only",
    });
    assert.match(turn2.finalResponse, /SCOUT_MULTI_TURN_DONE_2/, updatePlanReport({
      finalResponse: turn2.finalResponse,
      rawPlanUpdates,
      timelineKinds: [],
      plan: turn2.plan,
    }));

    const turn3 = await client.runTurn({
      threadId: thread.threadId,
      prompt: [
        "Turn 3: continue from the existing plan and complete SCOUT_MULTI_TURN_STEP_THREE.",
        "Call update_plan with explanation SCOUT_MULTI_TURN_EXPLANATION_3 and statuses completed, completed, completed.",
        "After update_plan, answer exactly SCOUT_MULTI_TURN_DONE_3.",
      ].join("\n"),
      timeoutMs: 120_000,
      permissions: ":read-only",
    });
    const planEntries = client.timelineSince(beforeSeq, {
      threadId: thread.threadId,
      stream: AppServerTimelineStreams.Plan,
    });
    const report = updatePlanReport({
      finalResponse: turn3.finalResponse,
      rawPlanUpdates,
      timelineKinds: planEntries.map((entry) => entry.kind),
      plan: turn3.plan,
    });

    assert.match(turn3.finalResponse, /SCOUT_MULTI_TURN_DONE_3/, report);
    assert.equal(rawPlanUpdates.length, 3, report);
    assert.equal(planEntries.filter((entry) => entry.kind === "plan_updated").length, 3, report);
    assertUniqueTurnUpdates(rawPlanUpdates, report);
    assert.deepEqual(rawPlanUpdates[0], {
      threadId: thread.threadId,
      turnId: rawPlanUpdates[0]?.turnId,
      explanation: "SCOUT_MULTI_TURN_EXPLANATION_1",
      steps: [
        { step: "SCOUT_MULTI_TURN_STEP_ONE", status: "completed" },
        { step: "SCOUT_MULTI_TURN_STEP_TWO", status: "inProgress" },
        { step: "SCOUT_MULTI_TURN_STEP_THREE", status: "pending" },
      ],
    }, report);
    assert.deepEqual(rawPlanUpdates[1], {
      threadId: thread.threadId,
      turnId: rawPlanUpdates[1]?.turnId,
      explanation: "SCOUT_MULTI_TURN_EXPLANATION_2",
      steps: [
        { step: "SCOUT_MULTI_TURN_STEP_ONE", status: "completed" },
        { step: "SCOUT_MULTI_TURN_STEP_TWO", status: "completed" },
        { step: "SCOUT_MULTI_TURN_STEP_THREE", status: "inProgress" },
      ],
    }, report);
    assert.deepEqual(rawPlanUpdates[2], {
      threadId: thread.threadId,
      turnId: rawPlanUpdates[2]?.turnId,
      explanation: "SCOUT_MULTI_TURN_EXPLANATION_3",
      steps: [
        { step: "SCOUT_MULTI_TURN_STEP_ONE", status: "completed" },
        { step: "SCOUT_MULTI_TURN_STEP_TWO", status: "completed" },
        { step: "SCOUT_MULTI_TURN_STEP_THREE", status: "completed" },
      ],
    }, report);
    assert.deepEqual(turn3.plan?.steps.map((step) => ({
      step: step.step,
      status: step.status,
    })), [
      { step: "SCOUT_MULTI_TURN_STEP_ONE", status: "completed" },
      { step: "SCOUT_MULTI_TURN_STEP_TWO", status: "completed" },
      { step: "SCOUT_MULTI_TURN_STEP_THREE", status: "completed" },
    ], report);
  } finally {
    client.close();
  }
});

interface RawTurnPlanUpdate {
  threadId?: string;
  turnId?: string;
  explanation: string | null;
  steps: Array<{
    step: string;
    status: string;
  }>;
}

function rawTurnPlanUpdate(notification: JsonRpcNotification): RawTurnPlanUpdate | undefined {
  if (notification.method !== "turn/plan/updated") return undefined;
  const params = readObject(notification.params);
  return {
    threadId: readOptionalString(params.threadId),
    turnId: readOptionalString(params.turnId),
    explanation: params.explanation === null ? null : readOptionalString(params.explanation) ?? null,
    steps: readArray(params.plan).map((step) => {
      const value = readObject(step);
      return {
        step: readString(value.step),
        status: readString(value.status),
      };
    }),
  };
}

function updatePlanReport(input: {
  finalResponse: string;
  rawPlanUpdates: RawTurnPlanUpdate[];
  timelineKinds: string[];
  plan: unknown;
}): string {
  return JSON.stringify(input, null, 2);
}

function assertUniqueTurnUpdates(updates: RawTurnPlanUpdate[], report: string): void {
  const turnIds = updates.map((update) => update.turnId).filter(isPresent);
  assert.equal(turnIds.length, updates.length, report);
  assert.equal(new Set(turnIds).size, updates.length, report);
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
