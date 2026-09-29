import { readAgentThreadRecord, type AgentThreadRecord } from "../../../agent/thread/agent-thread-record.js";
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { AgentBuilder } from "../../../agent/builder/agent-builder.js";
import type { ScoutAgent } from "../../../agent/core/scout-agent.js";
import { resolveSynthesisRole } from "../../../core/workflow/index.js";
import type { RunStage } from "../../lifecycle/index.js";
import { currentRunScope } from "../../run-scope.js";
import { isPathWithin, runAgentPaths, runPaths } from "../../../core/path.js";
import {
  projectRun,
  readDomainJournalProjections,
  type RunProjection,
} from "../projection/index.js";

/**
 * Reconstructs Scout agents and reconnects them to persisted Codex threads.
 * Agent entity records select the threads and copied Codex session files supply
 * the resumable rollout. An unfinished Workflow must reference the same identities.
 * The stage restores roles concurrently and stops any
 * partial restoration when one role fails. Task/context activation belongs to
 * later resume stages.
 */
export class RestoreAgentsStage implements RunStage {
  readonly id = "restore_agents";
  private stopped = false;

  /** Builds all role agents and restores each role's persisted thread state. */
  async start(): Promise<void> {
    const scope = currentRunScope();
    const graphState = scope.workflow.scheduler.snapshot();
    const synthesisRole = resolveSynthesisRole(graphState).name;
    const projection = scope.workflow.snapshot() ? projectRun(
      scope.workflow.readEvents(),
      synthesisRole,
      readDomainJournalProjections(scope.domainRegistry.list()),
    ) : undefined;
    const roles = graphState.roles.map((role) => role.name);
    const records = new Map(roles.map((role) => [role, readAgentThreadRecord(runAgentPaths(scope.runRoot, role).agentRoot, role)]));
    for (const thread of projection?.threads ?? []) {
      if (records.get(thread.agentId)?.thread.threadId !== thread.threadId) {
        throw new Error("Workflow Thread identity does not match its Agent entity: " + thread.agentId);
      }
    }
    const persistedThreadIds = [...records.values()].flatMap((record) => record ? [record.thread.threadId] : []);
    const requiredRolloutThreadIds = [...records.values()].flatMap((record) => record?.hasTurns ? [record.thread.threadId] : []);
    const rolloutPaths = locatePersistedRollouts({
      runRoot: scope.runRoot,
      threadIds: persistedThreadIds,
      requiredThreadIds: requiredRolloutThreadIds,
    });
    const builder = new AgentBuilder();
    const agents = roles.map((role) =>
      role === synthesisRole
        ? builder.buildCoordinator()
        : builder.buildWorker(role)
    );
    const settled = await Promise.allSettled(
      agents.map((agent) =>
        this.restoreAgent(agent, records.get(agent.agentId), projection, rolloutPaths)
      ),
    );
    const errors = settled
      .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
      .map((entry) => entry.reason);
    if (errors.length === 0) return;
    await this.stopAgents("agent_restore_failed");
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, `${errors.length} Scout agents failed to restore.`);
  }

  /** Stops restored agents once, preserving aggregate shutdown failures. */
  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const failures: unknown[] = [];
    try {
      await currentRunScope().workflow.quiesce();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.stopAgents(reason);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Workflow and restored Agents failed to stop.");
  }

  /**
   * Restores one role from its rollout, or delegates the no-resumable-state
   * path to the agent.
   */
  private async restoreAgent(
    agent: ScoutAgent,
    record: AgentThreadRecord | undefined,
    projection: RunProjection | undefined,
    rolloutPaths: ReadonlyMap<string, string>,
  ): Promise<void> {
    const thread = record?.thread;
    const agentTurns = (projection?.turns ?? []).filter((turn) =>
      turn.agentId === agent.agentId
    );
    const threadTurns = thread
      ? agentTurns.filter((turn) =>
          turn.threadId === thread.threadId
        )
      : [];
    const taskHasSteps = (projection?.tasks ?? []).some((task) =>
      task.agentId === agent.agentId && task.stepIds.length > 0
    );

    if (!thread) {
      if (taskHasSteps || agentTurns.length > 0) {
        throw new Error(
          `Cannot restore agent ${agent.agentId} without matching persisted thread memory.`,
        );
      }
      await agent.startThread();
      return;
    }

    const rolloutPath = rolloutPaths.get(thread.threadId);
    if (!rolloutPath) {
      if (record?.hasTurns || threadTurns.length > 0 || taskHasSteps) {
        throw new Error(
          `No persisted Codex rollout found for thread ${thread.threadId}.`,
        );
      }
      // Codex does not create a session row/file until a thread produces a
      // turn. A journaled thread with no such Codex record has no resumable
      // state; explicitly replace that journaled identity with a new thread.
      await agent.restartThread({
        previousThread: thread,
        reason: "codex_rollout_not_persisted",
      });
      return;
    }
    await agent.resumeThread({
      thread,
      rolloutPath,
    });
  }

  /** Stops the coordinator first, then workers, and aggregates cleanup errors. */
  private async stopAgents(reason: string): Promise<void> {
    const agents = currentRunScope().agentRegistry.listAgents();
    const synthesisRole = resolveSynthesisRole(
      currentRunScope().workflow.scheduler.snapshot(),
    ).name;
    const coordinator = agents.find((agent) =>
      agent.role === synthesisRole
    );
    const workers = agents.filter((agent) =>
      agent.role !== synthesisRole
    );
    const errors: unknown[] = [];
    if (coordinator) {
      try {
        await coordinator.stopAgent(reason);
      } catch (error) {
        errors.push(error);
      }
    }
    const settled = await Promise.allSettled(
      workers.map((agent) => agent.stopAgent(reason)),
    );
    errors.push(...settled
      .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
      .map((entry) => entry.reason));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `${errors.length} Scout agent runners failed to stop.`);
    }
  }
}

/**
 * Maps Agent thread ids to copied Codex rollout paths beneath the run's
 * Codex home. Only the first JSONL record is inspected for `session_meta`; a
 * missing rollout is fatal for a thread that has already executed a Turn.
 */
function locatePersistedRollouts(input: {
  runRoot: string;
  threadIds: string[];
  requiredThreadIds: string[];
}): ReadonlyMap<string, string> {
  if (input.threadIds.length === 0) return new Map();

  const runRoot = resolve(input.runRoot);
  const { codexHome, codexSessionsRoot: sessionsRoot } = runPaths(runRoot);
  const requireDirectory = (path: string, label: string): void => {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      throw new Error(`Cannot inspect ${label} ${path}.`, { cause: error });
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symlinked ${label}: ${path}.`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Expected ${label} to be a directory: ${path}.`);
    }
  };
  requireDirectory(codexHome, "Codex home");

  const runRootReal = realpathSync(runRoot);
  const codexHomeReal = realpathSync(codexHome);
  assertInside(codexHomeReal, runRootReal, "Codex home");

  const wantedThreadIds = new Set(input.threadIds);
  const requiredThreadIds = new Set(input.requiredThreadIds);
  const matches = new Map<string, string[]>();
  let sessionsStat: Stats | undefined;
  try {
    sessionsStat = lstatSync(sessionsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cannot inspect Codex sessions root ${sessionsRoot}.`, { cause: error });
    }
  }
  if (sessionsStat?.isSymbolicLink()) {
    throw new Error(`Refusing symlinked Codex sessions root: ${sessionsRoot}.`);
  }
  if (sessionsStat && !sessionsStat.isDirectory()) {
    throw new Error(`Expected Codex sessions root to be a directory: ${sessionsRoot}.`);
  }
  if (sessionsStat) {
    const sessionsRootReal = realpathSync(sessionsRoot);
    assertInside(sessionsRootReal, codexHomeReal, "Codex sessions root");
    const visit = (directory: string): void => {
      const directoryReal = realpathSync(directory);
      assertInside(directoryReal, sessionsRootReal, "Codex sessions directory");
      const entries = readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const path = join(directory, entry.name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
          throw new Error(`Refusing symlink beneath Codex sessions: ${path}.`);
        }
        if (stat.isDirectory()) {
          visit(path);
          continue;
        }
        if (!stat.isFile() || !entry.name.endsWith(".jsonl")) continue;

        const pathReal = realpathSync(path);
        assertInside(pathReal, sessionsRootReal, "Codex rollout");
        const firstLine = readFirstLine(path);
        let firstRecord: unknown;
        try {
          firstRecord = JSON.parse(firstLine);
        } catch {
          // Codex may leave unrelated or partially written JSONL files in the
          // copied sessions tree. They are not usable rollout candidates and
          // must not prevent valid persisted threads from being restored.
          continue;
        }
        if (!isSessionMeta(firstRecord)) continue;
        const threadId = firstRecord.payload.id;
        if (!wantedThreadIds.has(threadId)) continue;
        const rolloutPath = relative(codexHome, path);
        assertRelativeSessionsPath(rolloutPath, path);
        const threadMatches = matches.get(threadId) ?? [];
        threadMatches.push(rolloutPath);
        matches.set(threadId, threadMatches);
      }
    };
    visit(sessionsRoot);
  }

  const result = new Map<string, string>();
  for (const threadId of wantedThreadIds) {
    const threadMatches = matches.get(threadId) ?? [];
    if (threadMatches.length > 1) {
      throw new Error(
        `Multiple persisted Codex rollouts found for thread ${threadId}: ${threadMatches.join(", ")}.`,
      );
    }
    if (threadMatches.length === 0 && requiredThreadIds.has(threadId)) {
      throw new Error(`No persisted Codex rollout found for thread ${threadId}.`);
    }
    if (threadMatches.length === 1) result.set(threadId, threadMatches[0]);
  }
  return result;
}

/** Reads one bounded JSONL record without loading the complete rollout log. */
function readFirstLine(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let totalBytes = 0;
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      const newline = chunk.indexOf(0x0a);
      totalBytes += newline >= 0 ? newline : chunk.length;
      if (totalBytes > 16 * 1024 * 1024) {
        throw new Error(`First JSONL record in Codex rollout is too large: ${path}.`);
      }
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        break;
      }
      chunks.push(chunk);
    }
  } finally {
    closeSync(descriptor);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
}

/** Narrows an arbitrary JSON value to the Codex session identity record. */
function isSessionMeta(value: unknown): value is {
  type: "session_meta";
  payload: { id: string };
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== "session_meta") return false;
  if (typeof record.payload !== "object" || record.payload === null
    || Array.isArray(record.payload)) return false;
  return typeof (record.payload as Record<string, unknown>).id === "string";
}

/** Enforces that a resolved copied-session path remains beneath its owner root. */
function assertInside(path: string, root: string, label: string): void {
  if (isPathWithin(root, path)) return;
  throw new Error(`${label} escapes ${root}: ${path}.`);
}

/** Keeps the rollout reference portable and restricted to `.codex/sessions`. */
function assertRelativeSessionsPath(path: string, absolutePath: string): void {
  if (isAbsolute(path)
    || path === ".."
    || path.startsWith(`..${sep}`)
    || (path !== "sessions" && !path.startsWith(`sessions${sep}`))) {
    throw new Error(`Codex rollout is not beneath sessions: ${absolutePath}.`);
  }
}
