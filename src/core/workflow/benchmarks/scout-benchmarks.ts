import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { workflowPaths, runPaths } from "../../path.js";
import { Benchmarks } from "./benchmarks.js";
import type { BenchmarkObject, WorkflowLocation } from "./types.js";

const WORKFLOW_ID_PATTERN = /^workflow-([0-9]{3,})$/;

/** Jenkins-style stable pointers to retained Workflow journals. */
export interface ScoutBenchmarkLinks {
  currentWorkflow: string;
  lastWorkflow: string;
  lastRun: string;
  lastSuccess?: string;
}

export type ScoutBenchmarkName = keyof ScoutBenchmarkLinks;

/**
 * Scout-owned permalink rules and Workflow directory preparation.
 * The shared Benchmarks service owns file IO, locking, and reference queries.
 */
export class ScoutBenchmarks {
  constructor(readonly benchmarks: Benchmarks) {}

  get runRoot(): string { return this.benchmarks.runRoot; }
  get path(): string { return this.benchmarks.path; }
  private get workflowsRoot(): string { return runPaths(this.runRoot).workflowsRoot; }

  read(): ScoutBenchmarkLinks | undefined {
    const value = this.benchmarks.read("scout");
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw new Error(`Invalid Scout benchmarks: ${this.path}`);
    const names = ["currentWorkflow", "lastWorkflow", "lastRun", "lastSuccess"];
    if (Object.keys(value).some((key) => !names.includes(key))) {
      throw new Error(`Unsupported Scout benchmark fields: ${this.path}`);
    }
    const readReference = (name: ScoutBenchmarkName): string => {
      const reference = value[name];
      if (!isRecord(reference) || typeof reference.workflowId !== "string" || !reference.workflowId) {
        throw new Error(`Workflow benchmark ${name} must not be empty and must be a Workflow reference: ${this.path}`);
      }
      assertWorkflowId(reference.workflowId, `Workflow benchmark ${name}`);
      return reference.workflowId;
    };
    return {
      currentWorkflow: readReference("currentWorkflow"),
      lastWorkflow: readReference("lastWorkflow"),
      lastRun: readReference("lastRun"),
      ...(Object.hasOwn(value, "lastSuccess") ? { lastSuccess: readReference("lastSuccess") } : {}),
    };
  }

  /** Resolves one non-empty permalink without requiring its target to exist. */
  resolve(name: ScoutBenchmarkName): WorkflowLocation | undefined {
    const links = this.read();
    if (!links) return undefined;
    const workflowId = links[name];
    if (workflowId === undefined) return undefined;
    return this.findWorkflow(workflowId);
  }

  /** Resolves identity rather than the user-editable physical directory name. */
  findWorkflow(workflowId: string): WorkflowLocation | undefined {
    return this.benchmarks.resolve({ workflowId });
  }

  /**
   * Allocates the next Workflow id and forcefully replaces only that exact target
   * directory. Benchmark pointers are not changed until recordStarted succeeds.
   */
  prepareNext(): WorkflowLocation {
    this.benchmarks.assertOwned();
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
      if (this.benchmarks.referencesTo(replacedId).length > 0) throw new Error(`Cannot overwrite referenced Workflow ${replacedId}.`);
      rmSync(workflowRoot, { recursive: true, force: true });
    }
    mkdirSync(journalRoot, { recursive: true });
    writeFileSync(identityPath, `${JSON.stringify({ workflowId }, null, 2)}\n`, "utf8");
    return { workflowId, workflowRoot, journalRoot };
  }

  /** Removes one prepared Workflow directory when Workflow orchestration does not commit it. */
  discard(prepared: WorkflowLocation): void {
    this.benchmarks.assertOwned();
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
    if (this.benchmarks.referencesTo(prepared.workflowId).length > 0) throw new Error(`Cannot discard referenced Workflow ${prepared.workflowId}.`);
    rmSync(expectedRoot, { recursive: true, force: true });
  }

  /** Advances the current/last pointers after the Workflow's scout.journal exists. */
  recordStarted(workflowId: string): ScoutBenchmarkLinks {
    this.benchmarks.assertOwned();
    assertWorkflowId(workflowId, "started Workflow");
    const current = this.read();
    const next: ScoutBenchmarkLinks = {
      currentWorkflow: workflowId,
      lastWorkflow: workflowId,
      lastRun: workflowId,
      ...(current?.lastSuccess ? { lastSuccess: current.lastSuccess } : {}),
    };
    this.write(next);
    return structuredClone(next);
  }

  /** Records that an existing Workflow was selected for a runtime resume. */
  recordRun(workflowId: string): ScoutBenchmarkLinks {
    this.benchmarks.assertOwned();
    assertWorkflowId(workflowId, "run Workflow");
    const current = this.requireLinks();
    const next = { ...current, currentWorkflow: workflowId, lastRun: workflowId };
    this.write(next);
    return structuredClone(next);
  }

  /** Moves only the successful permalink; the other stable pointers are retained. */
  recordSuccess(workflowId: string): ScoutBenchmarkLinks {
    this.benchmarks.assertOwned();
    assertWorkflowId(workflowId, "successful Workflow");
    const current = this.requireLinks();
    const next = { ...current, lastSuccess: workflowId };
    this.write(next);
    return structuredClone(next);
  }

  private requireLinks(): ScoutBenchmarkLinks {
    const links = this.read();
    if (!links) throw new Error(`Workflow benchmarks do not exist: ${this.path}`);
    return links;
  }

  private write(links: ScoutBenchmarkLinks): void {
    const value: BenchmarkObject = {};
    for (const [name, workflowId] of Object.entries(links)) {
      assertWorkflowId(workflowId, `Workflow benchmark ${name}`);
      value[name] = { workflowId };
    }
    this.benchmarks.submit("scout", [{ path: [], value }]);
  }
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
