import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

export type LogSerializer = (event: LogEvent) => string;
export type LogRedactor = (event: LogEvent) => LogEvent;
export type LogSummarizer = (event: LogEvent) => LogEvent;

export interface LoggerOptions {
  runId: string;
  logsRoot: string;
  fileName?: string;
  serializer?: LogSerializer;
  redactor?: LogRedactor;
  summarizer?: LogSummarizer;
}

export class Logger {
  private readonly runId: string;
  private readonly globalLogPath: string;
  private readonly agentLogPaths = new Map<string, string>();
  private readonly serializer: LogSerializer;
  private readonly redactor: LogRedactor;
  private readonly summarizer: LogSummarizer;

  constructor(options: LoggerOptions) {
    this.runId = options.runId;
    this.globalLogPath = join(options.logsRoot, options.fileName ?? "runtime.jsonl");
    this.serializer = options.serializer ?? defaultLogSerializer;
    this.redactor = options.redactor ?? defaultLogRedactor;
    this.summarizer = options.summarizer ?? defaultLogSummarizer;
  }

  registerAgentLogRoot(agentId: string, logsRoot: string, fileName = "runtime.jsonl"): void {
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
    const serialized = this.serializer(this.redactor(this.summarizer(event))) + "\n";
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

function defaultLogSerializer(event: LogEvent): string {
  return JSON.stringify(event);
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
