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
  && process.env.SCOUT_RUN_CODEX_GOAL_EXPERIMENT === "1";
const GOAL_OBJECTIVE = "SCOUT_GOAL_OBJECTIVE_VERIFY_MULTI_TURN_TRACKING";
const GOAL_TOKEN_BUDGET = 1_000_000;

test("real Codex app-server exposes thread goal update and get across turns", {
  skip: enabled
    ? undefined
    : "set SCOUT_RUN_CODEX_APP_SERVER_INTEGRATION=1 and SCOUT_RUN_CODEX_GOAL_EXPERIMENT=1",
  timeout: 240_000,
}, async (context) => {
  const root = mkdtempSync(join(tmpdir(), "scout-goal-experiment-"));
  const userHome = process.env.HOME ?? root;
  const codexHome = process.env.CODEX_HOME ?? join(userHome, ".codex");
  if (!existsSync(codexHome)) {
    throw new Error(`Codex home does not exist: ${codexHome}`);
  }

  const client = new CodexAppServerClient({
    home: userHome,
    codexHome,
    logPrefix: "scout goal experiment app-server",
  });
  const rawGoalUpdates: RawGoalUpdate[] = [];
  client.onNotification((notification) => {
    const update = rawGoalUpdate(notification);
    if (update) {
      rawGoalUpdates.push(update);
      context.diagnostic(`thread/goal/updated #${rawGoalUpdates.length}:\n${JSON.stringify(update, null, 2)}`);
    }
  });

  try {
    await client.startSession();
    const thread = await client.startThread({
      cwd: root,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      baseInstructions: [
        "You are a Scout goal integration test agent.",
        "Do not run shell commands, read files, write files, or call external tools.",
        "Answer only the exact fixed text requested by each turn.",
      ].join("\n"),
      developerInstructions: "Do not update or complete the thread goal yourself.",
      config: {
        model_reasoning_effort: "minimal",
      },
    });

    const beforeSeq = client.currentTimelineSeq();
    const goal = await client.setThreadGoal({
      threadId: thread.threadId,
      objective: GOAL_OBJECTIVE,
      tokenBudget: GOAL_TOKEN_BUDGET,
    });
    context.diagnostic(`setThreadGoal normalized:\n${JSON.stringify(goal, null, 2)}`);
    const goalGetAfterSet = await client.request("thread/goal/get", {
      threadId: thread.threadId,
    });
    context.diagnostic(`thread/goal/get after set:\n${JSON.stringify(goalGetAfterSet, null, 2)}`);

    for (const turnIndex of [1, 2, 3]) {
      const turn = await client.runTurn({
        threadId: thread.threadId,
        prompt: `Answer exactly SCOUT_GOAL_TURN_${turnIndex}_DONE.`,
        timeoutMs: 120_000,
        sandbox: "readOnly",
      });
      context.diagnostic(`turn ${turnIndex} result:\n${JSON.stringify({
        turnId: turn.turnId,
        finalResponse: turn.finalResponse,
        goal: turn.goal,
      }, null, 2)}`);
      assert.equal(turn.goal?.threadId, thread.threadId, goalReport({
        rawGoalUpdates,
        goalGetAfterSet,
        latestGoal: turn.goal,
        timelineKinds: [],
      }));

      const goalGet = await client.request("thread/goal/get", {
        threadId: thread.threadId,
      });
      context.diagnostic(`thread/goal/get after turn ${turnIndex}:\n${JSON.stringify(goalGet, null, 2)}`);
      assertGoalGetResponse(goalGet, thread.threadId, { requireActive: false });
    }

    const goalEntries = client.timelineSince(beforeSeq, {
      threadId: thread.threadId,
      stream: AppServerTimelineStreams.State,
    });
    const latestThreadGoal = client.getEventStoreSnapshot().threads[thread.threadId]?.goal;
    const report = goalReport({
      rawGoalUpdates,
      goalGetAfterSet,
      latestGoal: latestThreadGoal,
      timelineKinds: goalEntries.map((entry) => entry.kind),
    });

    assert.ok(rawGoalUpdates.length >= 1, report);
    assert.equal(rawGoalUpdates[0]?.threadId, thread.threadId, report);
    assert.equal(rawGoalUpdates[0]?.goal.objective, GOAL_OBJECTIVE, report);
    assert.equal(rawGoalUpdates[0]?.goal.status, "active", report);
    assert.equal(rawGoalUpdates[0]?.goal.tokenBudget, GOAL_TOKEN_BUDGET, report);
    for (const update of rawGoalUpdates) {
      assert.equal(update.threadId, thread.threadId, report);
      assert.equal(update.goal.objective, GOAL_OBJECTIVE, report);
      assert.equal(update.goal.tokenBudget, GOAL_TOKEN_BUDGET, report);
      assert.equal(typeof update.goal.status, "string", report);
      assert.equal(typeof update.goal.tokensUsed, "number", report);
      assert.equal(typeof update.goal.timeUsedSeconds, "number", report);
    }
    assert.ok(goalEntries.some((entry) => entry.kind === "goal_updated"), report);
    assert.equal(latestThreadGoal?.objective, GOAL_OBJECTIVE, report);
    assert.equal(typeof latestThreadGoal?.status, "string", report);
    assert.equal(latestThreadGoal?.tokenBudget, GOAL_TOKEN_BUDGET, report);
    assertGoalGetResponse(goalGetAfterSet, thread.threadId, { requireActive: true });
  } finally {
    client.close();
  }
});

interface RawGoalUpdate {
  threadId?: string;
  goal: {
    threadId?: string;
    objective?: string;
    status?: string;
    tokenBudget?: number;
    tokensUsed?: number;
    timeUsedSeconds?: number;
    createdAt?: number;
    updatedAt?: number;
    raw: Record<string, unknown>;
  };
}

function rawGoalUpdate(notification: JsonRpcNotification): RawGoalUpdate | undefined {
  if (notification.method !== "thread/goal/updated") return undefined;
  const params = readObject(notification.params);
  const goal = readObject(params.goal);
  return {
    threadId: readOptionalString(params.threadId),
    goal: {
      threadId: readOptionalString(goal.threadId),
      objective: readOptionalString(goal.objective),
      status: readOptionalString(goal.status),
      tokenBudget: readOptionalNumber(goal.tokenBudget),
      tokensUsed: readOptionalNumber(goal.tokensUsed),
      timeUsedSeconds: readOptionalNumber(goal.timeUsedSeconds),
      createdAt: readOptionalNumber(goal.createdAt),
      updatedAt: readOptionalNumber(goal.updatedAt),
      raw: goal,
    },
  };
}

function assertGoalGetResponse(value: unknown, threadId: string, options: { requireActive: boolean }): void {
  const root = readObject(value);
  const goal = readObject(root.goal);
  assert.equal(readOptionalString(goal.threadId), threadId, JSON.stringify(value, null, 2));
  assert.equal(readOptionalString(goal.objective), GOAL_OBJECTIVE, JSON.stringify(value, null, 2));
  if (options.requireActive) {
    assert.equal(readOptionalString(goal.status), "active", JSON.stringify(value, null, 2));
  } else {
    assert.equal(typeof readOptionalString(goal.status), "string", JSON.stringify(value, null, 2));
  }
  assert.equal(readOptionalNumber(goal.tokenBudget), GOAL_TOKEN_BUDGET, JSON.stringify(value, null, 2));
  assert.equal(typeof readOptionalNumber(goal.tokensUsed), "number", JSON.stringify(value, null, 2));
  assert.equal(typeof readOptionalNumber(goal.timeUsedSeconds), "number", JSON.stringify(value, null, 2));
}

function goalReport(input: {
  rawGoalUpdates: RawGoalUpdate[];
  goalGetAfterSet: unknown;
  latestGoal: unknown;
  timelineKinds: string[];
}): string {
  return JSON.stringify(input, null, 2);
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
