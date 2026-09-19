import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  completeCommandExecutionApproval,
  evaluateCommandExecutionApproval,
  MERGED_CONTENT_READ_REASON,
} from "../../src/agent/command-execution/approval/command-execution-approval-policy.js";
import { handleCodexNativeHook } from "../../src/agent-server/codex/codex-native-hook.js";

test("command approval allows discovery plus one primary result", () => {
  const result = evaluateCommandExecutionApproval(`/bin/zsh -c 'pwd
scout-assets summary
scout-assets family rbt --phase execute
scout-assets skill domain-rbt-executor'`);

  assert.deepEqual(result, { decision: "allow" });
});

test("command approval treats one source filtering pipeline as one primary result", () => {
  assert.deepEqual(
    evaluateCommandExecutionApproval(`/bin/zsh -lc "set -o pipefail
scout-assets skill tool-codegraph | sed -n '1,35p'"`),
    { decision: "allow" },
  );
  assert.deepEqual(
    evaluateCommandExecutionApproval("rg -n 'BehaviorNode' src | head -n 20"),
    { decision: "allow" },
  );
  assert.deepEqual(
    evaluateCommandExecutionApproval("cat source.ts | sed -n '1,80p'"),
    { decision: "allow" },
  );
});

test("command approval allows bounded Skill metadata discovery", () => {
  const result = evaluateCommandExecutionApproval(`/bin/zsh -c 'scout-assets skill first
scout-assets skill second'`);

  assert.deepEqual(result, { decision: "allow" });
});

test("command approval denies independent content reads joined by shell operators", () => {
  for (const command of [
    "sed -n '1,80p' first.ts; sed -n '1,80p' second.ts",
    "cat first.ts && rg -n symbol second.ts",
    "codegraph node First -p /code || codegraph query Second -p /code",
    "cat first.ts | cat second.ts",
  ]) {
    assert.deepEqual(evaluateCommandExecutionApproval(command), {
      decision: "deny",
      reason: MERGED_CONTENT_READ_REASON,
    });
  }
});

test("command approval ignores bounded status and whole-result operations", () => {
  assert.deepEqual(
    evaluateCommandExecutionApproval("codegraph status /code -j; git diff; npm test"),
    { decision: "allow" },
  );
});

test("command approval serializes concurrent primary reads until completion", (t) => {
  const stateRoot = mkdtempSync(join(tmpdir(), "scout-command-approval-state-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));

  assert.deepEqual(evaluateCommandExecutionApproval("cat first.ts", {
    stateRoot,
    invocationId: "tool-1",
  }), { decision: "allow" });
  assert.deepEqual(evaluateCommandExecutionApproval("rg -n symbol second.ts", {
    stateRoot,
    invocationId: "tool-2",
  }), {
    decision: "deny",
    reason: MERGED_CONTENT_READ_REASON,
  });
  assert.deepEqual(evaluateCommandExecutionApproval("pwd; scout-assets summary; scout-assets skill tool-codegraph", {
    stateRoot,
    invocationId: "tool-metadata",
  }), { decision: "allow" });

  completeCommandExecutionApproval(stateRoot, "tool-1");
  assert.deepEqual(evaluateCommandExecutionApproval("rg -n symbol second.ts", {
    stateRoot,
    invocationId: "tool-2",
  }), { decision: "allow" });
});

test("Codex native hook maps Bash PreToolUse through the Agent hook router", (t) => {
  const stateRoot = mkdtempSync(join(tmpdir(), "scout-codex-native-hook-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const output = handleCodexNativeHook({
    session_id: "session-1",
    cwd: "/workspace",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "tool-1",
    tool_input: {
      command: "cat first.ts; cat second.ts",
    },
  }, {
    runId: "run-1",
    agentId: "executor",
    stateRoot,
  });

  assert.deepEqual(output, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: MERGED_CONTENT_READ_REASON,
    },
  });
});

test("Codex native hook releases primary-read state on PostToolUse", (t) => {
  const stateRoot = mkdtempSync(join(tmpdir(), "scout-codex-native-hook-post-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const context = { runId: "run-1", agentId: "executor", stateRoot };
  const input = {
    session_id: "session-1",
    cwd: "/workspace",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "tool-1",
    tool_input: { command: "cat first.ts" },
  };

  assert.equal(
    handleCodexNativeHook(input, context)?.hookSpecificOutput.permissionDecision,
    "allow",
  );
  assert.equal(handleCodexNativeHook({
    ...input,
    hook_event_name: "PostToolUse",
  }, context), undefined);
  assert.equal(
    handleCodexNativeHook({ ...input, tool_use_id: "tool-2" }, context)
      ?.hookSpecificOutput.permissionDecision,
    "allow",
  );
});

test("Codex native hook ignores unrelated native events", () => {
  assert.equal(handleCodexNativeHook({
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
  }, {
    runId: "run-1",
    agentId: "executor",
    stateRoot: "/tmp/scout-unused-hook-state",
  }), undefined);
});
