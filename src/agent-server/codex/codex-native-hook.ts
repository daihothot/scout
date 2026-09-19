import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { routeAgentHook } from "../../agent/hooks/route-agent-hook.js";

interface CodexToolUseInput {
  session_id: string;
  cwd: string;
  hook_event_name: "PreToolUse" | "PostToolUse";
  tool_name: string;
  tool_use_id: string;
  tool_input: {
    command?: unknown;
  };
}

interface NativeHookContext {
  runId: string;
  agentId: string;
  stateRoot: string;
}

type CodexPreToolUseOutput = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason?: string;
  };
};

/** Converts Codex tool-use hook payloads into Scout's synchronous Hook contract. */
export function handleCodexNativeHook(
  input: unknown,
  context: NativeHookContext,
): CodexPreToolUseOutput | undefined {
  if (
    !isRecord(input)
    || (input.hook_event_name !== "PreToolUse" && input.hook_event_name !== "PostToolUse")
    || input.tool_name !== "Bash"
  ) {
    return undefined;
  }
  if (
    typeof input.session_id !== "string"
    || typeof input.cwd !== "string"
    || typeof input.tool_use_id !== "string"
    || !isRecord(input.tool_input)
    || typeof input.tool_input.command !== "string"
  ) {
    throw new Error("Codex Bash tool-use hook payload is missing its command identity.");
  }

  const payload = input as unknown as CodexToolUseInput;
  if (payload.hook_event_name === "PostToolUse") {
    routeAgentHook({
      kind: "command_execution_completed",
      runId: context.runId,
      agentId: context.agentId,
      invocationId: payload.tool_use_id,
      stateRoot: context.stateRoot,
    });
    return undefined;
  }
  const result = routeAgentHook({
    kind: "command_execution_approval",
    runId: context.runId,
    agentId: context.agentId,
    invocationId: payload.tool_use_id,
    stateRoot: context.stateRoot,
    cwd: payload.cwd,
    command: payload.tool_input.command as string,
  });
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: result.decision,
      ...(result.decision === "deny" ? { permissionDecisionReason: result.reason } : {}),
    },
  };
}

async function run(): Promise<void> {
  const context = readContext(process.argv.slice(2));
  let source = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) source += chunk;
  const output = handleCodexNativeHook(JSON.parse(source), context);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

function readContext(arguments_: string[]): NativeHookContext {
  const valueAfter = (name: string): string | undefined => {
    const index = arguments_.indexOf(name);
    return index >= 0 ? arguments_[index + 1] : undefined;
  };
  const runId = valueAfter("--run-id");
  const agentId = valueAfter("--agent-id");
  const stateRoot = valueAfter("--state-root");
  if (!runId || !agentId || !stateRoot) {
    throw new Error("Codex native hook requires --run-id, --agent-id, and --state-root.");
  }
  return { runId, agentId, stateRoot };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
