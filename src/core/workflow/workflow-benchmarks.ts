import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { workflowPaths, runPaths } from "../path.js";
import { WorkflowBenchmarkLock } from "./workflow-benchmark-lock.js";

const WORKFLOW_ID_PATTERN = /^workflow-([0-9]{3,})$/;

/** Jenkins-style stable pointers to retained Workflow journals. */
export interface WorkflowBenchmarkLinks {
  version: 1;
  currentWorkflow: string;
  lastWorkflow: string;
  lastRun: string;
  lastSuccess?: string;
}

export type WorkflowBenchmarkName = Exclude<keyof WorkflowBenchmarkLinks, "version">;

/** A numbered Workflow directory selected before its journals are created. */
export interface PreparedWorkflow {
  workflowId: string;
  workflowRoot: string;
  journalRoot: string;
}

/**
 * Owns one Run's Workflow benchmark file and Workflow directories under workflows/.
 * Pointer replacement is atomic; directory and scout.journal construction
 * remain the Workflow owner's transaction.
 */
export class WorkflowBenchmarks {
  readonly runRoot: string;
  readonly path: string;
  private readonly workflowsRoot: string;
  private readonly lock: WorkflowBenchmarkLock;

  constructor(runRoot: string) {
    this.runRoot = resolve(runRoot);
    const paths = runPaths(this.runRoot);
    this.path = paths.benchmarksPath;
    this.workflowsRoot = paths.workflowsRoot;
    this.lock = new WorkflowBenchmarkLock(paths.workflowLockPath);
  }

  /** Held by Workflow for the whole runtime, including all Workflow transitions. */
  acquire(): void {
    mkdirSync(this.runRoot, { recursive: true });
    this.lock.acquire();
  }

  release(): void {
    this.lock.release();
  }

  read(): WorkflowBenchmarkLinks | undefined {
    if (!existsSync(this.path)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      throw new Error(`Invalid Workflow benchmarks JSON: ${this.path}`, { cause: error });
    }
    if (!isRecord(parsed)) throw new Error(`Invalid Workflow benchmarks document: ${this.path}`);
    if (!Object.hasOwn(parsed, "scout")) {
      if (Object.hasOwn(parsed, "version")) throw new Error(`Unsupported flat Workflow benchmarks: ${this.path}`);
      return undefined;
    }
    return validateLinks(parsed.scout, this.path);
  }

  /** Resolves one non-empty permalink without requiring its target to exist. */
  resolve(name: WorkflowBenchmarkName): PreparedWorkflow | undefined {
    const links = this.read();
    if (!links) return undefined;
    const workflowId = links[name];
    if (workflowId === undefined) return undefined;
    return this.findWorkflow(workflowId);
  }

  /** Resolves identity rather than the user-editable physical directory name. */
  findWorkflow(workflowId: string): PreparedWorkflow | undefined {
    assertWorkflowId(workflowId, "Workflow reference");
    if (!existsSync(this.workflowsRoot)) return undefined;
    let found: PreparedWorkflow | undefined;
    for (const entry of readdirSync(this.workflowsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const workflowRoot = join(this.workflowsRoot, entry.name);
      const { identityPath, journalRoot } = workflowPaths(workflowRoot);
      if (!existsSync(identityPath)) continue;
      const identity: unknown = JSON.parse(readFileSync(identityPath, "utf8"));
      if (!isRecord(identity) || typeof identity.workflowId !== "string") {
        throw new Error(`Invalid Workflow identity: ${identityPath}`);
      }
      assertWorkflowId(identity.workflowId, identityPath);
      if (identity.workflowId !== workflowId) continue;
      if (found) throw new Error(`Duplicate Workflow identity ${workflowId}: ${found.workflowRoot}, ${workflowRoot}`);
      found = { workflowId, workflowRoot, journalRoot };
    }
    return found;
  }

  /**
   * Allocates the next Workflow id and forcefully replaces only that exact target
   * directory. Benchmark pointers are not changed until recordStarted succeeds.
   */
  prepareNext(): PreparedWorkflow {
    this.lock.assertOwned();
    const links = this.read();
    const workflowId = nextWorkflowId(links?.lastWorkflow);
    const workflowRoot = join(this.workflowsRoot, workflowId);
    const { identityPath, journalRoot } = workflowPaths(workflowRoot);
    mkdirSync(this.workflowsRoot, { recursive: true });
    const existing = this.findWorkflow(workflowId);
    if (existing && existing.workflowRoot !== workflowRoot) {
      throw new Error(`Cannot allocate existing Workflow identity ${workflowId}: ${existing.workflowRoot}`);
    }
    if (existsSync(workflowRoot)) {
      const identity: unknown = existsSync(identityPath) ? JSON.parse(readFileSync(identityPath, "utf8")) : undefined;
      const replacedId = isRecord(identity) && typeof identity.workflowId === "string" ? identity.workflowId : workflowId;
      const pinnedBy = links
        ? (["currentWorkflow", "lastWorkflow", "lastRun", "lastSuccess"] as const)
          .filter((name) => links[name] === workflowId || links[name] === replacedId)
        : [];
      if (pinnedBy.length > 0) {
        throw new Error(
          `Cannot overwrite Workflow ${workflowId}; it is referenced by ${pinnedBy.join(", ")}.`,
        );
      }
      const document: unknown = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
      if (containsWorkflowReference(document, replacedId)) throw new Error(`Cannot overwrite referenced Workflow ${replacedId}.`);
      rmSync(workflowRoot, { recursive: true, force: true });
    }
    mkdirSync(journalRoot, { recursive: true });
    writeFileSync(identityPath, `${JSON.stringify({ workflowId }, null, 2)}\n`, "utf8");
    return { workflowId, workflowRoot, journalRoot };
  }

  /** Removes one prepared Workflow directory when Workflow orchestration does not commit it. */
  discard(prepared: PreparedWorkflow): void {
    this.lock.assertOwned();
    assertWorkflowId(prepared.workflowId, "prepared Workflow");
    const expectedRoot = join(this.workflowsRoot, prepared.workflowId);
    if (resolve(prepared.workflowRoot) !== expectedRoot || resolve(prepared.journalRoot) !== workflowPaths(expectedRoot).journalRoot) {
      throw new Error(
        `Prepared Workflow root does not match ${prepared.workflowId}: ${prepared.journalRoot}`,
      );
    }
    const links = this.read();
    const pinnedBy = links
      ? (["currentWorkflow", "lastWorkflow", "lastRun", "lastSuccess"] as const)
        .filter((name) => links[name] === prepared.workflowId)
      : [];
    if (pinnedBy.length > 0) {
      throw new Error(
        `Cannot discard Workflow ${prepared.workflowId}; it is referenced by ${pinnedBy.join(", ")}.`,
      );
    }
    const document: unknown = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
    if (containsWorkflowReference(document, prepared.workflowId)) throw new Error(`Cannot discard referenced Workflow ${prepared.workflowId}.`);
    rmSync(expectedRoot, { recursive: true, force: true });
  }

  /** Advances the current/last pointers after the Workflow's scout.journal exists. */
  recordStarted(workflowId: string): WorkflowBenchmarkLinks {
    this.lock.assertOwned();
    assertWorkflowId(workflowId, "started Workflow");
    const current = this.read();
    const next: WorkflowBenchmarkLinks = {
      version: 1,
      currentWorkflow: workflowId,
      lastWorkflow: workflowId,
      lastRun: workflowId,
      ...(current?.lastSuccess ? { lastSuccess: current.lastSuccess } : {}),
    };
    this.write(next);
    return structuredClone(next);
  }

  /** Records that an existing Workflow was selected for a runtime resume. */
  recordRun(workflowId: string): WorkflowBenchmarkLinks {
    this.lock.assertOwned();
    assertWorkflowId(workflowId, "run Workflow");
    const current = this.requireLinks();
    const next = { ...current, currentWorkflow: workflowId, lastRun: workflowId };
    this.write(next);
    return structuredClone(next);
  }

  /** Moves only the successful permalink; the other stable pointers are retained. */
  recordSuccess(workflowId: string): WorkflowBenchmarkLinks {
    this.lock.assertOwned();
    assertWorkflowId(workflowId, "successful Workflow");
    const current = this.requireLinks();
    const next = { ...current, lastSuccess: workflowId };
    this.write(next);
    return structuredClone(next);
  }

  private requireLinks(): WorkflowBenchmarkLinks {
    const links = this.read();
    if (!links) throw new Error(`Workflow benchmarks do not exist: ${this.path}`);
    return links;
  }

  private write(links: WorkflowBenchmarkLinks): void {
    validateLinks(links, this.path);
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    const document: unknown = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
    if (!isRecord(document)) throw new Error(`Invalid Workflow benchmarks document: ${this.path}`);
    writeFileSync(temporaryPath, `${JSON.stringify({ ...document, scout: links }, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, this.path);
  }
}

function validateLinks(input: unknown, path: string): WorkflowBenchmarkLinks {
  if (!isRecord(input) || input.version !== 1) {
    throw new Error(`Workflow benchmarks must have version 1: ${path}`);
  }
  for (const name of ["currentWorkflow", "lastWorkflow", "lastRun"] as const) {
    const value = input[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Workflow benchmark ${name} must not be empty: ${path}`);
    }
    assertWorkflowId(value, `Workflow benchmark ${name}`);
  }
  if (Object.hasOwn(input, "lastSuccess")) {
    if (typeof input.lastSuccess !== "string" || input.lastSuccess.trim().length === 0) {
      throw new Error(`Workflow benchmark lastSuccess must not be empty: ${path}`);
    }
    assertWorkflowId(input.lastSuccess, "Workflow benchmark lastSuccess");
  }
  return structuredClone(input) as unknown as WorkflowBenchmarkLinks;
}

function nextWorkflowId(lastWorkflow: string | undefined): string {
  if (lastWorkflow === undefined) return "workflow-001";
  const match = WORKFLOW_ID_PATTERN.exec(lastWorkflow);
  if (!match?.[1]) throw new Error(`Invalid Workflow benchmark lastWorkflow: ${lastWorkflow}`);
  const next = Number.parseInt(match[1], 10) + 1;
  if (!Number.isSafeInteger(next)) throw new Error(`Workflow sequence overflow: ${lastWorkflow}`);
  return `workflow-${String(next).padStart(Math.max(3, match[1].length), "0")}`;
}

function assertWorkflowId(value: string, label: string): void {
  if (!WORKFLOW_ID_PATTERN.test(value)) throw new Error(`${label} is invalid: ${value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Prevents deleting identities referenced by any namespace in the shared document. */
function containsWorkflowReference(value: unknown, workflowId: string): boolean {
  if (value === workflowId) return true;
  if (Array.isArray(value)) return value.some((entry) => containsWorkflowReference(entry, workflowId));
  return isRecord(value) && Object.values(value).some((entry) => containsWorkflowReference(entry, workflowId));
}
