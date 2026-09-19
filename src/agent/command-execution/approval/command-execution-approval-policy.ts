import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AgentHookResult } from "../../hooks/types.js";

export const MERGED_CONTENT_READ_REASON =
  "[MERGED_CONTENT_READ] one primary result is allowed per shell tool call";

/** Enforces Scout's single-primary-result rule for one shell tool call. */
export function evaluateCommandExecutionApproval(
  command: string,
  lease?: { stateRoot: string; invocationId: string },
): AgentHookResult {
  type Token = { kind: "word" | "pipe" | "separator"; value: string };

  const tokenize = (source: string): Token[] => {
    const tokens: Token[] = [];
    let word = "";
    let quote: "'" | '"' | null = null;
    let escaped = false;

    const flushWord = (): void => {
      if (word.length === 0) return;
      tokens.push({ kind: "word", value: word });
      word = "";
    };

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        word += character;
        escaped = false;
        continue;
      }
      if (character === "\\" && quote !== "'") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = null;
        else word += character;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        continue;
      }
      if (character === "\n" || character === ";") {
        flushWord();
        tokens.push({ kind: "separator", value: character });
        continue;
      }
      if (character === "|") {
        flushWord();
        if (source[index + 1] === "|") {
          tokens.push({ kind: "separator", value: "||" });
          index += 1;
        } else {
          tokens.push({ kind: "pipe", value: "|" });
        }
        continue;
      }
      if (character === "&" && source[index - 1] !== ">" && source[index - 1] !== "<") {
        flushWord();
        if (source[index + 1] === "&") index += 1;
        tokens.push({ kind: "separator", value: "&" });
        continue;
      }
      if (/\s/.test(character)) {
        flushWord();
        continue;
      }
      word += character;
    }
    if (escaped) word += "\\";
    flushWord();
    return tokens;
  };

  const executableIndex = (words: string[]): number => {
    let index = 0;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
    if (words[index] === "command" || words[index] === "exec") index += 1;
    if (words[index] === "env") {
      index += 1;
      while (
        index < words.length
        && (words[index].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))
      ) index += 1;
    }
    return index;
  };

  const shellScript = (words: string[]): string | undefined => {
    const start = executableIndex(words);
    const executable = words[start]?.split("/").at(-1);
    if (!executable || !["bash", "dash", "sh", "zsh"].includes(executable)) return undefined;
    for (let index = start + 1; index < words.length; index += 1) {
      const argument = words[index];
      if (/^-[^-]*c/.test(argument)) return words[index + 1] === "--" ? words[index + 2] : words[index + 1];
    }
    return undefined;
  };

  const primaryStageCount = (words: string[], pipelineIndex: number, depth: number): number => {
    if (words.length === 0) return 0;
    const nestedScript = shellScript(words);
    if (nestedScript !== undefined && depth < 4) return primaryResultCount(nestedScript, depth + 1);

    const start = executableIndex(words);
    const executable = words[start]?.split("/").at(-1);
    if (!executable) return 0;
    if (executable === "codegraph") {
      return words[start + 1] === "node" || words[start + 1] === "query" ? 1 : 0;
    }
    if (executable === "cat" || executable === "rg") return 1;
    if (executable === "sed") return pipelineIndex === 0 ? 1 : 0;
    return 0;
  };

  const primaryResultCount = (source: string, depth = 0): number => {
    const tokens = tokenize(source);
    let count = 0;
    let words: string[] = [];
    let pipelineIndex = 0;

    const finishStage = (): void => {
      count += primaryStageCount(words, pipelineIndex, depth);
      words = [];
      pipelineIndex += 1;
    };

    for (const token of tokens) {
      if (token.kind === "word") {
        words.push(token.value);
        continue;
      }
      finishStage();
      if (count > 1) return count;
      if (token.kind === "separator") pipelineIndex = 0;
    }
    finishStage();
    return count;
  };

  const resultCount = primaryResultCount(command);
  if (resultCount > 1) return { decision: "deny", reason: MERGED_CONTENT_READ_REASON };
  if (resultCount === 1 && lease && !acquirePrimaryReadLease(lease.stateRoot, lease.invocationId)) {
    return { decision: "deny", reason: MERGED_CONTENT_READ_REASON };
  }
  return { decision: "allow" };
}

/** Releases the primary-read slot after the matching native PostToolUse event. */
export function completeCommandExecutionApproval(stateRoot: string, invocationId: string): void {
  const path = primaryReadLeasePath(stateRoot);
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    unlinkSync(path);
    return;
  }
  if (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as Record<string, unknown>).invocationId === invocationId
  ) unlinkSync(path);
}

function acquirePrimaryReadLease(stateRoot: string, invocationId: string): boolean {
  const path = primaryReadLeasePath(stateRoot);
  mkdirSync(dirname(path), { recursive: true });
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return typeof value === "object"
        && value !== null
        && !Array.isArray(value)
        && (value as Record<string, unknown>).invocationId === invocationId;
    } catch {
      return false;
    }
  }
  try {
    writeFileSync(descriptor, JSON.stringify({ invocationId }));
  } finally {
    closeSync(descriptor);
  }
  return true;
}

function primaryReadLeasePath(stateRoot: string): string {
  return join(stateRoot, "agent-hooks", "primary-content-read.lock");
}
