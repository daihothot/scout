import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir } from "../fs.js";

/** Severity labels emitted in the line-oriented runtime log. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured event fields retained after summarization and redaction. */
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

/** Hook that removes sensitive values before an event is serialized. */
export type LogRedactor = (event: LogEvent) => LogEvent;
/** Hook that bounds large values before an event is serialized. */
export type LogSummarizer = (event: LogEvent) => LogEvent;
/** Event fields callers provide; timestamp, level, and run identity belong to the logger. */
export type LogInput = Omit<LogEvent, "timestamp" | "level" | "runId">;

/** Runtime identity and output/pipeline configuration for a {@link Logger}. */
export interface LoggerOptions {
  runId: string;
  logsRoot: string;
  fileName?: string;
  redactor?: LogRedactor;
  summarizer?: LogSummarizer;
}

const LOG_LINE_WIDTH = 120;

/** Appends structured, summarized, and redacted runtime events to one run log. */
export class Logger {
  private readonly runId: string;
  private readonly logPath: string;
  private readonly redactor: LogRedactor;
  private readonly summarizer: LogSummarizer;

  constructor(options: LoggerOptions) {
    this.runId = options.runId;
    this.logPath = join(options.logsRoot, options.fileName ?? "runtime.log");
    this.redactor = options.redactor ?? defaultLogRedactor;
    this.summarizer = options.summarizer ?? defaultLogSummarizer;
  }

  debug(input: LogInput): void {
    this.write("debug", input);
  }

  info(input: LogInput): void {
    this.write("info", input);
  }

  warn(input: LogInput): void {
    this.write("warn", input);
  }

  error(input: LogInput): void {
    this.write("error", input);
  }

  private write(level: LogLevel, input: LogInput): void {
    const event = {
      timestamp: new Date().toISOString(),
      level,
      runId: this.runId,
      ...input,
    };
    const processed = this.redactor(this.summarizer(event));
    const serialized = formatLogEvent(processed);
    this.append(this.logPath, serialized);
  }

  private append(logPath: string, serialized: string): void {
    ensureDir(dirname(logPath));
    appendFileSync(logPath, serialized, "utf8");
  }
}

function formatLogEvent(event: LogEvent): string {
  const fields = [
    event.timestamp,
    levelLabel(event.level),
    `module=${event.module}`,
    `event=${event.event}`,
    `run=${event.runId ?? "-"}`,
    event.agentId ? `agent=${event.agentId}` : undefined,
    event.taskId ? `task=${event.taskId}` : undefined,
  ].filter((part): part is string => Boolean(part)).join(" ");
  if (event.data === undefined) return `${fields}\n\n`;
  return `${fields}\n${formatLogData(event.data)}\n\n`;
}

function levelLabel(level: LogLevel): string {
  switch (level) {
    case "debug":
      return "DEBUG";
    case "info":
      return "INFO";
    case "warn":
      return "WARN";
    case "error":
      return "ERROR";
  }
}

function formatLogData(value: unknown): string {
  if (typeof value === "string" && shouldUseStringBlock(value, "data: ")) {
    return ["data: |", ...formatStringBlock(value, 1)].join("\n");
  }
  if (isScalar(value)) return `data: ${formatScalar(value)}`;
  return ["data:", ...formatValueLines(value, 1)].join("\n");
}

function formatValueLines(value: unknown, indentLevel: number): string[] {
  const indentation = indent(indentLevel);
  if (typeof value === "string") {
    return shouldUseStringBlock(value, indentation)
      ? [`${indentation}|`, ...formatStringBlock(value, indentLevel + 1)]
      : [`${indentation}${formatScalar(value)}`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indentation}[]`];
    return value.flatMap((entry) => formatArrayEntry(entry, indentLevel));
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${indentation}{}`];
    return entries.flatMap(([key, entry]) => formatObjectEntry(key, entry, indentLevel));
  }
  return [`${indentation}${formatScalar(value)}`];
}

function formatObjectEntry(key: string, value: unknown, indentLevel: number): string[] {
  const indentation = indent(indentLevel);
  const label = formatKey(key);
  if (typeof value === "string" && shouldUseStringBlock(value, `${indentation}${label}: `)) {
    return [
      `${indentation}${label}: |`,
      ...formatStringBlock(value, indentLevel + 1),
    ];
  }
  if (isScalar(value)) {
    return [`${indentation}${label}: ${formatScalar(value)}`];
  }
  if (Array.isArray(value) && value.length === 0) {
    return [`${indentation}${label}: []`];
  }
  if (isPlainObject(value) && Object.keys(value).length === 0) {
    return [`${indentation}${label}: {}`];
  }
  return [
    `${indentation}${label}:`,
    ...formatValueLines(value, indentLevel + 1),
  ];
}

function formatArrayEntry(value: unknown, indentLevel: number): string[] {
  const indentation = indent(indentLevel);
  if (typeof value === "string" && shouldUseStringBlock(value, `${indentation}- `)) {
    return [
      `${indentation}- |`,
      ...formatStringBlock(value, indentLevel + 1),
    ];
  }
  if (isScalar(value)) return [`${indentation}- ${formatScalar(value)}`];
  if (Array.isArray(value) && value.length === 0) return [`${indentation}- []`];
  if (isPlainObject(value) && Object.keys(value).length === 0) return [`${indentation}- {}`];
  return [
    `${indentation}-`,
    ...formatValueLines(value, indentLevel + 1),
  ];
}

function shouldUseStringBlock(value: string, prefix: string): boolean {
  return value.includes("\n")
    || Array.from(`${prefix}${formatScalar(value)}`).length > LOG_LINE_WIDTH;
}

function formatStringBlock(value: string, indentLevel: number): string[] {
  const indentation = indent(indentLevel);
  const width = Math.max(1, LOG_LINE_WIDTH - indentation.length);
  return value.split("\n").flatMap((line) =>
    wrapLogLine(line, width).map((part) => `${indentation}${part}`)
  );
}

function wrapLogLine(value: string, width: number): string[] {
  const chars = Array.from(value);
  if (chars.length === 0) return [""];
  const lines: string[] = [];
  for (let index = 0; index < chars.length; index += width) {
    lines.push(chars.slice(index, index + width).join(""));
  }
  return lines;
}

function formatScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  return String(value);
}

function formatKey(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value) ? value : JSON.stringify(value);
}

function isScalar(value: unknown): boolean {
  return value === null
    || value === undefined
    || (typeof value !== "object");
}

function indent(level: number): string {
  return "  ".repeat(level);
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
