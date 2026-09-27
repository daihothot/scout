import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WorkflowBenchmarkLock } from "./workflow-benchmark-lock.js";

const FLOW_ID_PATTERN = /^journal-([0-9]{4,})$/;

/** Jenkins-style stable pointers to retained Workflow Flow journals. */
export interface WorkflowBenchmarkLinks {
  version: 1;
  currentFlow: string;
  lastFlow: string;
  lastRun: string;
  lastSuccess?: string;
}

export type WorkflowBenchmarkName = Exclude<keyof WorkflowBenchmarkLinks, "version">;

/** A numbered Flow directory selected before its journals are created. */
export interface PreparedWorkflowFlow {
  flowId: string;
  journalRoot: string;
}

/**
 * Owns one Run's Workflow benchmark file and numbered Flow directories.
 * Pointer replacement is atomic; directory and scout.journal construction
 * remain the Workflow owner's transaction.
 */
export class WorkflowBenchmarks {
  readonly runRoot: string;
  readonly path: string;
  private readonly lock: WorkflowBenchmarkLock;

  constructor(runRoot: string) {
    this.runRoot = resolve(runRoot);
    this.path = join(this.runRoot, "benchmarks.json");
    this.lock = new WorkflowBenchmarkLock(join(this.runRoot, ".workflow.lock"));
  }

  /** Held by Workflow for the whole runtime, including all Flow transitions. */
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
    return validateLinks(parsed, this.path);
  }

  /** Resolves one non-empty permalink without requiring its target to exist. */
  resolve(name: WorkflowBenchmarkName): PreparedWorkflowFlow | undefined {
    const links = this.read();
    if (!links) return undefined;
    const flowId = links[name];
    if (flowId === undefined) return undefined;
    return { flowId, journalRoot: join(this.runRoot, flowId) };
  }

  /**
   * Allocates the next Flow id and forcefully replaces only that exact target
   * directory. Benchmark pointers are not changed until recordStarted succeeds.
   */
  prepareNext(): PreparedWorkflowFlow {
    this.lock.assertOwned();
    const links = this.read();
    const flowId = nextFlowId(links?.lastFlow);
    const journalRoot = join(this.runRoot, flowId);
    mkdirSync(this.runRoot, { recursive: true });
    if (existsSync(journalRoot)) {
      const pinnedBy = links
        ? (["currentFlow", "lastFlow", "lastRun", "lastSuccess"] as const)
          .filter((name) => links[name] === flowId)
        : [];
      if (pinnedBy.length > 0) {
        throw new Error(
          `Cannot overwrite Workflow Flow ${flowId}; it is referenced by ${pinnedBy.join(", ")}.`,
        );
      }
      rmSync(journalRoot, { recursive: true, force: true });
    }
    mkdirSync(journalRoot, { recursive: true });
    return { flowId, journalRoot };
  }

  /** Removes one prepared Flow directory when Workflow orchestration does not commit it. */
  discard(prepared: PreparedWorkflowFlow): void {
    this.lock.assertOwned();
    assertFlowId(prepared.flowId, "prepared Flow");
    const expectedRoot = join(this.runRoot, prepared.flowId);
    if (resolve(prepared.journalRoot) !== expectedRoot) {
      throw new Error(
        `Prepared Workflow Flow root does not match ${prepared.flowId}: ${prepared.journalRoot}`,
      );
    }
    const links = this.read();
    const pinnedBy = links
      ? (["currentFlow", "lastFlow", "lastRun", "lastSuccess"] as const)
        .filter((name) => links[name] === prepared.flowId)
      : [];
    if (pinnedBy.length > 0) {
      throw new Error(
        `Cannot discard Workflow Flow ${prepared.flowId}; it is referenced by ${pinnedBy.join(", ")}.`,
      );
    }
    rmSync(expectedRoot, { recursive: true, force: true });
  }

  /** Advances the current/last pointers after the Flow's scout.journal exists. */
  recordStarted(flowId: string): WorkflowBenchmarkLinks {
    this.lock.assertOwned();
    assertFlowId(flowId, "started Flow");
    const current = this.read();
    const next: WorkflowBenchmarkLinks = {
      version: 1,
      currentFlow: flowId,
      lastFlow: flowId,
      lastRun: flowId,
      ...(current?.lastSuccess ? { lastSuccess: current.lastSuccess } : {}),
    };
    this.write(next);
    return structuredClone(next);
  }

  /** Records that an existing Flow was selected for a runtime resume. */
  recordRun(flowId: string): WorkflowBenchmarkLinks {
    this.lock.assertOwned();
    assertFlowId(flowId, "run Flow");
    const current = this.requireLinks();
    const next = { ...current, currentFlow: flowId, lastRun: flowId };
    this.write(next);
    return structuredClone(next);
  }

  /** Moves only the successful permalink; the other stable pointers are retained. */
  recordSuccess(flowId: string): WorkflowBenchmarkLinks {
    this.lock.assertOwned();
    assertFlowId(flowId, "successful Flow");
    const current = this.requireLinks();
    const next = { ...current, lastSuccess: flowId };
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
    writeFileSync(temporaryPath, `${JSON.stringify(links, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, this.path);
  }
}

function validateLinks(input: unknown, path: string): WorkflowBenchmarkLinks {
  if (!isRecord(input) || input.version !== 1) {
    throw new Error(`Workflow benchmarks must have version 1: ${path}`);
  }
  for (const name of ["currentFlow", "lastFlow", "lastRun"] as const) {
    const value = input[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Workflow benchmark ${name} must not be empty: ${path}`);
    }
    assertFlowId(value, `Workflow benchmark ${name}`);
  }
  if (Object.hasOwn(input, "lastSuccess")) {
    if (typeof input.lastSuccess !== "string" || input.lastSuccess.trim().length === 0) {
      throw new Error(`Workflow benchmark lastSuccess must not be empty: ${path}`);
    }
    assertFlowId(input.lastSuccess, "Workflow benchmark lastSuccess");
  }
  return structuredClone(input) as unknown as WorkflowBenchmarkLinks;
}

function nextFlowId(lastFlow: string | undefined): string {
  if (lastFlow === undefined) return "journal-0001";
  const match = FLOW_ID_PATTERN.exec(lastFlow);
  if (!match?.[1]) throw new Error(`Invalid Workflow benchmark lastFlow: ${lastFlow}`);
  const next = Number.parseInt(match[1], 10) + 1;
  if (!Number.isSafeInteger(next)) throw new Error(`Workflow Flow sequence overflow: ${lastFlow}`);
  return `journal-${String(next).padStart(Math.max(4, match[1].length), "0")}`;
}

function assertFlowId(value: string, label: string): void {
  if (!FLOW_ID_PATTERN.test(value)) throw new Error(`${label} is invalid: ${value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
