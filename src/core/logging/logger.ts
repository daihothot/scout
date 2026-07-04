import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { threadId as workerThreadId } from "node:worker_threads";
import { ensureDir } from "../fs.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  timestamp: string;
  level: LogLevel;
  module: string;
  event: string;
  runId?: string;
  agentId?: string;
  taskId?: string;
  data?: unknown;
}

export type LogRedactor = (event: LogEvent) => LogEvent;
export type LogSummarizer = (event: LogEvent) => LogEvent;

export interface LoggerOptions {
  runId: string;
  logsRoot: string;
  fileName?: string;
  redactor?: LogRedactor;
  summarizer?: LogSummarizer;
}

export class Logger {
  private readonly runId: string;
  private readonly globalLogPath: string;
  private readonly agentLogPaths = new Map<string, string>();
  private readonly redactor: LogRedactor;
  private readonly summarizer: LogSummarizer;

  constructor(options: LoggerOptions) {
    this.runId = options.runId;
    this.globalLogPath = join(options.logsRoot, options.fileName ?? "runtime.log");
    this.redactor = options.redactor ?? defaultLogRedactor;
    this.summarizer = options.summarizer ?? defaultLogSummarizer;
  }

  registerAgentLogRoot(agentId: string, logsRoot: string, fileName = "runtime.log"): void {
    this.agentLogPaths.set(agentId, join(logsRoot, fileName));
  }

  debug(input: Omit<LogEvent, "timestamp" | "level" | "runId">): void {
    this.write("debug", input);
  }

  info(input: Omit<LogEvent, "timestamp" | "level" | "runId">): void {
    this.write("info", input);
  }

  warn(input: Omit<LogEvent, "timestamp" | "level" | "runId">): void {
    this.write("warn", input);
  }

  error(input: Omit<LogEvent, "timestamp" | "level" | "runId">): void {
    this.write("error", input);
  }

  private write(level: LogLevel, input: Omit<LogEvent, "timestamp" | "level" | "runId">): void {
    const event = {
      timestamp: new Date().toISOString(),
      level,
      runId: this.runId,
      ...input,
    };
    const processed = this.redactor(this.summarizer(event));
    const serialized = formatLogEvent(processed);
    this.append(this.globalLogPath, serialized);
    if (!input.agentId) return;
    const agentLogPath = this.agentLogPaths.get(input.agentId);
    if (!agentLogPath || agentLogPath === this.globalLogPath) return;
    this.append(agentLogPath, serialized);
  }

  private append(logPath: string, serialized: string): void {
    ensureDir(dirname(logPath));
    appendFileSync(logPath, serialized, "utf8");
  }
}

function formatLogEvent(event: LogEvent): string {
  const source = event.agentId ?? "runtime";
  const header = [
    formatLogTimestamp(event.timestamp),
    "[Scout]",
    `[${runtimeThreadId()}]`,
    `[ ${levelLabel(event.level)} ]`,
    `[${event.module}]`,
    `[${source}]`,
    `event=${event.event}`,
    event.taskId ? `task=${event.taskId}` : undefined,
    `run=${event.runId ?? "-"}`,
  ].filter((part): part is string => Boolean(part)).join(" ");
  const body = formatLogBody(event.data);
  return body ? `\n\n\n${header}\n${body}\n` : `\n\n\n${header}\n`;
}

function formatLogBody(value: unknown, indentLevel = 1): string {
  if (value === undefined) return "";
  const lines = formatValueLines(value, indentLevel);
  return lines.join("\n");
}

function formatValueLines(value: unknown, indentLevel: number): string[] {
  const indentation = indent(indentLevel);
  if (typeof value === "string") {
    return formatStringLines(value, indentLevel);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indentation}[]`];
    return value.flatMap((entry, index) => [
      `${indentation}- [${index}]`,
      ...formatValueLines(entry, indentLevel + 1),
    ]);
  }
  if (!isPlainObject(value)) return [`${indentation}${String(value)}`];
  const entries = Object.entries(value);
  if (entries.length === 0) return [`${indentation}{}`];
  return entries.flatMap(([key, entry]) => {
    if (typeof entry === "string" && shouldFormatStringBlock(entry)) {
      return [
        `${indentation}${key}:`,
        ...formatStringLines(entry, indentLevel + 1),
      ];
    }
    if (isScalar(entry)) {
      return [`${indentation}${key}: ${String(entry)}`];
    }
    return [
      `${indentation}${key}:`,
      ...formatValueLines(entry, indentLevel + 1),
    ];
  });
}

function formatStringLines(value: string, indentLevel: number): string[] {
  const indentation = indent(indentLevel);
  const json = parseReadableJsonString(value);
  if (json !== undefined) {
    return JSON.stringify(json, null, 2).split("\n").map((line) => `${indentation}${line}`);
  }
  if (looksLikeXml(value)) {
    return formatXml(value).split("\n").map((line) => `${indentation}${line}`);
  }
  if (looksLikeYaml(value)) {
    return value.split("\n").map((line) => `${indentation}${line}`);
  }
  return [`${indentation}${value}`];
}

function shouldFormatStringBlock(value: string): boolean {
  return parseReadableJsonString(value) !== undefined
    || looksLikeXml(value)
    || looksLikeYaml(value);
}

function parseReadableJsonString(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function looksLikeXml(value: string): boolean {
  const trimmed = value.trim();
  return /^<([A-Za-z_][\w:.-]*)(\s[^>]*)?>[\s\S]*<\/\1>$/.test(trimmed)
    || /^<\?xml\b/.test(trimmed);
}

function formatXml(value: string): string {
  const compact = value.trim().replace(/>\s+</g, "><");
  const tokens = compact.replace(/></g, ">\n<").split("\n");
  let depth = 0;
  return tokens.map((token) => {
    const trimmed = token.trim();
    if (/^<\//.test(trimmed)) depth = Math.max(0, depth - 1);
    const line = `${indent(depth)}${trimmed}`;
    if (/^<[^!?/][^>]*[^/]>(?!.*<\/[^>]+>$)/.test(trimmed)) depth += 1;
    return line;
  }).join("\n");
}

function looksLikeYaml(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.includes("\n")
    && /^[\w.-]+:\s*.+/m.test(trimmed);
}

function formatLogTimestamp(value: string): string {
  const date = new Date(value);
  const source = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = source.getFullYear();
  const month = pad2(source.getMonth() + 1);
  const day = pad2(source.getDate());
  const hours = pad2(source.getHours());
  const minutes = pad2(source.getMinutes());
  const seconds = pad2(source.getSeconds());
  const milliseconds = String(source.getMilliseconds()).padStart(3, "0");
  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function runtimeThreadId(): string {
  return `pid:${process.pid}/thread:${workerThreadId}`;
}

function levelLabel(level: LogLevel): string {
  switch (level) {
    case "debug":
      return "D";
    case "info":
      return "I";
    case "warn":
      return "W";
    case "error":
      return "E";
  }
}

function isScalar(value: unknown): boolean {
  return value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean";
}

function indent(level: number): string {
  return "  ".repeat(level);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function defaultLogRedactor(event: LogEvent): LogEvent {
  return {
    ...event,
    data: redactValue(event.data),
  };
}

function defaultLogSummarizer(event: LogEvent): LogEvent {
  return {
    ...event,
    data: summarizeValue(event.data),
  };
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    shouldRedactKey(key) ? "[redacted]" : redactValue(entry),
  ]));
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 4000 ? `${value.slice(0, 4000)}...[truncated:${value.length}]` : value;
  }
  if (Array.isArray(value)) {
    const summarized = value.slice(0, 200).map(summarizeValue);
    return value.length > 200
      ? [...summarized, `[truncated_items:${value.length - 200}]`]
      : summarized;
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    summarizeValue(entry),
  ]));
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("secret")
    || normalized.includes("token")
    || normalized.includes("password")
    || normalized.includes("apikey")
    || normalized.includes("api_key")
    || normalized === "authorization";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
