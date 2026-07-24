import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  EventKey,
  ScoutEvent,
} from "../../core/events/index.js";
import type { RunJournalEvent } from "./journal-events.js";

interface RunLockRecord {
  runId: string;
  processId: number;
  token: string;
  acquiredAt: string;
}

export class RunJournal {
  readonly runId: string;
  readonly runRoot: string;
  readonly path: string;
  private readonly lockPath: string;
  private readonly lockToken: string;
  private events: RunJournalEvent[];
  private closed = false;
  private appendFailure?: Error;

  private constructor(input: {
    runId: string;
    runRoot: string;
    events: RunJournalEvent[];
    lockToken: string;
  }) {
    this.runId = input.runId;
    this.runRoot = input.runRoot;
    this.path = join(input.runRoot, "events.jsonl");
    this.lockPath = join(input.runRoot, ".run.lock");
    this.lockToken = input.lockToken;
    this.events = input.events;
  }

  static create(input: { runId: string; runRoot: string }): RunJournal {
    mkdirSync(input.runRoot, { recursive: true });
    const path = join(input.runRoot, "events.jsonl");
    if (existsSync(path) && readFileSync(path, "utf8").trim().length > 0) {
      throw new Error(`Run journal already exists: ${path}`);
    }
    if (!existsSync(path)) writeFileSync(path, "", "utf8");
    return RunJournal.open(input);
  }

  static open(input: { runId: string; runRoot: string }): RunJournal {
    const path = join(input.runRoot, "events.jsonl");
    if (!existsSync(path)) throw new Error(`Run journal does not exist: ${path}`);
    const lockToken = acquireRunLock(input.runId, input.runRoot);
    try {
      repairIncompleteTail(path);
      return new RunJournal({
        ...input,
        events: readJournalEvents(path),
        lockToken,
      });
    } catch (error) {
      releaseRunLock(join(input.runRoot, ".run.lock"), lockToken);
      throw error;
    }
  }

  append(input: ScoutEvent): RunJournalEvent {
    if (this.closed) throw new Error(`Run journal ${this.runId} is closed.`);
    if (this.appendFailure) {
      try {
        repairIncompleteTail(this.path);
        this.events = readJournalEvents(this.path);
        const lastEvent = this.events[this.events.length - 1];
        if (
          lastEvent?.id === input.id
          && lastEvent.key.routeKey === input.key.routeKey
          && lastEvent.occurredAt === input.occurredAt
        ) {
          this.appendFailure = undefined;
          return structuredClone(lastEvent);
        }
      } catch (error) {
        this.appendFailure = error instanceof Error ? error : new Error(String(error));
        throw this.appendFailure;
      }
    }
    try {
      const seq = (this.events[this.events.length - 1]?.seq ?? 0) + 1;
      const event: RunJournalEvent = {
        id: input.id,
        key: persistedEventKey(input.key),
        payload: structuredClone(input.payload),
        occurredAt: input.occurredAt,
        version: 1 as const,
        seq,
        recordedAt: new Date().toISOString(),
      };
      appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
      this.events.push(event);
      this.appendFailure = undefined;
      return structuredClone(event);
    } catch (error) {
      this.appendFailure = error instanceof Error ? error : new Error(String(error));
      throw this.appendFailure;
    }
  }

  readAll(): RunJournalEvent[] {
    return structuredClone(this.events);
  }

  get lastSeq(): number {
    return this.events[this.events.length - 1]?.seq ?? 0;
  }

  get failed(): boolean {
    return this.appendFailure !== undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    releaseRunLock(this.lockPath, this.lockToken);
  }
}

function repairIncompleteTail(path: string): void {
  const content = readFileSync(path);
  if (content.length === 0 || content[content.length - 1] === 0x0a) return;
  const lastNewline = content.lastIndexOf(0x0a);
  truncateSync(path, lastNewline < 0 ? 0 : lastNewline + 1);
}

export function readJournalEvents(path: string): RunJournalEvent[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop();
  const events: RunJournalEvent[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    let event: RunJournalEvent;
    try {
      event = JSON.parse(line) as RunJournalEvent;
    } catch (error) {
      throw new Error(`Invalid run journal JSON at line ${index + 1}: ${String(error)}`);
    }
    const expectedSeq = events.length + 1;
    if (
      event.version !== 1
      || event.seq !== expectedSeq
      || typeof event.id !== "string"
      || typeof event.occurredAt !== "string"
      || !isPersistedEventKey(event.key)
    ) {
      throw new Error(`Invalid run journal event at line ${index + 1}; expected seq ${expectedSeq}.`);
    }
    events.push(event);
  }
  return events;
}

function persistedEventKey(key: EventKey): EventKey {
  return {
    scope: key.scope,
    group: key.group,
    name: key.name,
    ...(key.tag === undefined ? {} : { tag: key.tag }),
    routeKey: key.routeKey,
  };
}

function isPersistedEventKey(value: unknown): value is EventKey {
  if (!value || typeof value !== "object") return false;
  const key = value as Partial<EventKey>;
  return typeof key.scope === "string"
    && typeof key.group === "string"
    && typeof key.name === "string"
    && typeof key.routeKey === "string"
    && (key.tag === undefined || typeof key.tag === "string");
}

function acquireRunLock(runId: string, runRoot: string): string {
  const lockPath = join(runRoot, ".run.lock");
  const token = randomUUID();
  const record: RunLockRecord = {
    runId,
    processId: process.pid,
    token,
    acquiredAt: new Date().toISOString(),
  };
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      return token;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = readLockRecord(lockPath);
      if (existing && isProcessAlive(existing.processId)) {
        throw new Error(`Run ${runId} is already attached to process ${existing.processId}.`);
      }
      unlinkSync(lockPath);
    }
  }
  throw new Error(`Unable to acquire run lock: ${lockPath}`);
}

function releaseRunLock(lockPath: string, token: string): void {
  if (!existsSync(lockPath)) return;
  const existing = readLockRecord(lockPath);
  if (!existing || existing.token !== token) {
    throw new Error(`Cannot release run lock owned by another runtime: ${lockPath}`);
  }
  unlinkSync(lockPath);
}

function readLockRecord(path: string): RunLockRecord | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunLockRecord;
  } catch {
    return undefined;
  }
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}
