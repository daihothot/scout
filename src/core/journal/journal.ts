import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { EventKey, ScoutEvent } from "../events/index.js";
import type { JournalEvent } from "./journal-event.js";

interface JournalLockRecord {
  journalId: string;
  hostId: string;
  processId: number;
  token: string;
  acquiredAt: string;
}

export interface JournalLocation {
  journalId: string;
  path: string;
  lockPath: string;
}

/** Generic append-only event storage with a host-aware runtime lock. */
export class Journal {
  readonly journalId: string;
  readonly path: string;
  readonly lockPath: string;
  private readonly lockToken: string;
  private events: JournalEvent[];
  private closed = false;
  private appendFailure?: Error;

  private constructor(input: JournalLocation & {
    events: JournalEvent[];
    lockToken: string;
  }) {
    this.journalId = input.journalId;
    this.path = input.path;
    this.lockPath = input.lockPath;
    this.events = input.events;
    this.lockToken = input.lockToken;
  }

  static create(input: JournalLocation): Journal {
    mkdirSync(dirname(input.path), { recursive: true });
    if (existsSync(input.path) && readFileSync(input.path, "utf8").trim().length > 0) {
      throw new Error(`Journal already exists: ${input.path}`);
    }
    if (!existsSync(input.path)) writeFileSync(input.path, "", "utf8");
    return Journal.open(input);
  }

  static open(input: JournalLocation): Journal {
    if (!existsSync(input.path)) throw new Error(`Journal does not exist: ${input.path}`);
    const lockToken = acquireJournalLock(input);
    try {
      repairIncompleteJournalTail(input.path);
      return new Journal({
        ...input,
        events: readJournalEvents(input.path),
        lockToken,
      });
    } catch (error) {
      releaseJournalLock(input.lockPath, lockToken);
      throw error;
    }
  }

  append(input: ScoutEvent): JournalEvent {
    if (this.closed) throw new Error(`Journal ${this.journalId} is closed.`);
    if (this.appendFailure) {
      try {
        repairIncompleteJournalTail(this.path);
        this.events = readJournalEvents(this.path);
        const lastEvent = this.events.at(-1);
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
      const event: JournalEvent = {
        id: input.id,
        key: persistedEventKey(input.key),
        payload: structuredClone(input.payload),
        occurredAt: input.occurredAt,
        version: 1,
        seq: (this.events.at(-1)?.seq ?? 0) + 1,
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

  replaceAll(inputs: readonly ScoutEvent[]): JournalEvent[] {
    if (this.closed) throw new Error(`Journal ${this.journalId} is closed.`);
    const recordedAt = new Date().toISOString();
    const events = inputs.map((input, index): JournalEvent => ({
      id: input.id,
      key: persistedEventKey(input.key),
      payload: structuredClone(input.payload),
      occurredAt: input.occurredAt,
      version: 1,
      seq: index + 1,
      recordedAt,
    }));
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporaryPath,
        events.length === 0 ? "" : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
        "utf8",
      );
      renameSync(temporaryPath, this.path);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not exist when creation itself failed.
      }
      throw error;
    }
    this.events = events;
    this.appendFailure = undefined;
    return structuredClone(events);
  }

  readAll(): JournalEvent[] {
    return structuredClone(this.events);
  }

  get lastSeq(): number {
    return this.events.at(-1)?.seq ?? 0;
  }

  get failed(): boolean {
    return this.appendFailure !== undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    releaseJournalLock(this.lockPath, this.lockToken);
  }
}

/** Parses and validates a Journal without acquiring its runtime lock. */
export function readJournalEvents(path: string): JournalEvent[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop();
  const events: JournalEvent[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    let event: JournalEvent;
    try {
      event = JSON.parse(line) as JournalEvent;
    } catch (error) {
      throw new Error(`Invalid journal JSON at line ${index + 1}: ${String(error)}`);
    }
    const expectedSeq = events.length + 1;
    if (
      event.version !== 1
      || event.seq !== expectedSeq
      || typeof event.id !== "string"
      || typeof event.occurredAt !== "string"
      || !isPersistedEventKey(event.key)
    ) {
      throw new Error(`Invalid journal event at line ${index + 1}; expected seq ${expectedSeq}.`);
    }
    events.push(event);
  }
  return events;
}

function repairIncompleteJournalTail(path: string): void {
  const content = readFileSync(path);
  if (content.length === 0 || content[content.length - 1] === 0x0a) return;
  const lastNewline = content.lastIndexOf(0x0a);
  truncateSync(path, lastNewline < 0 ? 0 : lastNewline + 1);
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

function acquireJournalLock(input: JournalLocation): string {
  const token = randomUUID();
  const hostId = hostname();
  const record: JournalLockRecord = {
    journalId: input.journalId,
    hostId,
    processId: process.pid,
    token,
    acquiredAt: new Date().toISOString(),
  };
  mkdirSync(dirname(input.lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(input.lockPath, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      return token;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = readLockRecord(input.lockPath);
      if (existing && existing.hostId !== hostId) {
        throw new Error(
          `Journal ${input.journalId} is locked by host ${existing.hostId ?? "unknown"}`
          + ` process ${existing.processId ?? "unknown"}; current host is ${hostId}.`,
        );
      }
      if (existing && isProcessAlive(existing.processId)) {
        throw new Error(
          `Journal ${input.journalId} is already attached to process ${existing.processId}`
          + ` on host ${hostId}.`,
        );
      }
      unlinkSync(input.lockPath);
    }
  }
  throw new Error(`Unable to acquire Journal lock: ${input.lockPath}`);
}

function releaseJournalLock(lockPath: string, token: string): void {
  if (!existsSync(lockPath)) return;
  const existing = readLockRecord(lockPath);
  if (!existing || existing.token !== token) {
    throw new Error(`Cannot release Journal lock owned by another runtime: ${lockPath}`);
  }
  unlinkSync(lockPath);
}

function readLockRecord(path: string): JournalLockRecord | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JournalLockRecord;
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
