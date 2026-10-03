import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { agentEntityPaths } from "../../core/io/index.js";
import type { AgentThreadSnapshot } from "./types.js";

/** Agent-owned recovery identity. Workflow journals are not the authority for a live Thread. */
export interface AgentThreadRecord {
  version: 1;
  thread: AgentThreadSnapshot;
  hasTurns: boolean;
}

export function readAgentThreadRecord(agentRoot: string, agentId: string): AgentThreadRecord | undefined {
  const path = agentEntityPaths(agentRoot).threadRecordPath;
  if (!existsSync(path)) return undefined;
  const record = JSON.parse(readFileSync(path, "utf8")) as AgentThreadRecord;
  if (record.version !== 1 || typeof record.hasTurns !== "boolean"
    || !record.thread || record.thread.agentId !== agentId || record.thread.role !== agentId
    || typeof record.thread.threadId !== "string" || !record.thread.threadId
    || !record.thread.startInput || record.thread.startInput.ephemeral !== false
    || (record.thread.status !== "active" && record.thread.status !== "closed")) {
    throw new Error(`Invalid Agent Thread record: ${path}`);
  }
  return record;
}

export function writeAgentThreadRecord(agentRoot: string, record: AgentThreadRecord): void {
  mkdirSync(agentRoot, { recursive: true });
  const path = agentEntityPaths(agentRoot).threadRecordPath;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}
