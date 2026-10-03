import { Benchmarks } from "./benchmarks.js";
import type { BenchmarkObject } from "./types.js";

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
 * Scout-owned permalink rules only. Workflow owns directory and lifecycle transactions;
 * the shared Benchmarks service owns node persistence and reference queries.
 */
export class ScoutBenchmarks {
  constructor(readonly benchmarks: Benchmarks) {}

  get runRoot(): string { return this.benchmarks.runRoot; }
  get path(): string { return this.benchmarks.path; }

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

  /** Advances the current/last pointers after the Workflow's scout.journal exists. */
  recordStarted(workflowId: string): ScoutBenchmarkLinks {
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
    assertWorkflowId(workflowId, "run Workflow");
    const current = this.requireLinks();
    const next = { ...current, currentWorkflow: workflowId, lastRun: workflowId };
    this.write(next);
    return structuredClone(next);
  }

  /** Moves only the successful permalink; the other stable pointers are retained. */
  recordSuccess(workflowId: string): ScoutBenchmarkLinks {
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

function assertWorkflowId(value: string, label: string): void {
  if (!WORKFLOW_ID_PATTERN.test(value)) throw new Error(`${label} is invalid: ${value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
