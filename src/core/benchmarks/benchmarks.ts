import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runPaths, type WorkflowStorageLock } from "../io/index.js";
import type {
  BenchmarkNode, BenchmarkObject, BenchmarkReferenceNode, BenchmarkValue,
  BenchmarkWrite,
} from "./types.js";

/** Run-local chapter/node storage and Workflow reference queries; no business field semantics. */
export class Benchmarks {
  readonly runRoot: string;
  readonly path: string;
  /** Without a Workflow-owned writer lease this instance is read-only. */
  constructor(runRoot: string, private readonly writer?: WorkflowStorageLock) {
    this.runRoot = resolve(runRoot);
    const paths = runPaths(this.runRoot);
    this.path = paths.benchmarksPath;
  }

  read(section: string, path: readonly string[] = []): BenchmarkValue | undefined {
    assertAddress(section, path);
    const document = this.readDocument();
    let value: BenchmarkValue | undefined = Object.hasOwn(document, section) ? document[section] : undefined;
    for (const segment of path) {
      if (typeof value !== "object" || value === null || !Object.hasOwn(value, segment)) return undefined;
      value = Array.isArray(value) ? value[Number(segment)] : value[segment];
    }
    return value;
  }

  /** Lists immediate child nodes without interpreting their values. */
  list(section: string, path: readonly string[] = []): BenchmarkNode[] {
    const value = this.read(section, path);
    if (value === undefined) return [];
    if (typeof value !== "object" || value === null) {
      throw new Error(`Benchmark node has no children: ${section}/${path.join("/")}`);
    }
    return Object.entries(value).map(([name, child]) => ({ section, path: [...path, name], value: child }));
  }

  /** Merges only the submitted nodes, preserving other chapters and manual edits. */
  submit(section: string, writes: readonly BenchmarkWrite[]): void {
    if (!this.writer) throw new Error(`Workflow storage lock must be acquired before mutation: ${this.path}`);
    this.writer.assertOwned();
    assertAddress(section, []);
    if (writes.length === 0) return;
    for (const write of writes) {
      assertAddress(section, write.path);
      assertValue(write.value);
      if (write.path.length === 0 && (typeof write.value !== "object" || write.value === null || Array.isArray(write.value))) {
        throw new Error(`Benchmark chapter must be an object: ${section}`);
      }
    }
    // One synchronous read/modify/rename under the owned lease. Never persist a cached document.
    const document = this.readDocument();
    for (const write of writes) {
      let parent = document;
      const address = [section, ...write.path];
      for (const segment of address.slice(0, -1)) {
        if (!Object.hasOwn(parent, segment)) parent[segment] = {};
        const child = parent[segment];
        if (typeof child !== "object" || child === null || Array.isArray(child)) {
          throw new Error(`Cannot write through a non-object benchmark node: ${section}/${write.path.join("/")}`);
        }
        parent = child;
      }
      parent[address.at(-1)!] = structuredClone(write.value);
    }
    assertValue(document);
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, this.path);
  }

  /** Searches explicit Workflow references, never strings embedded in business content. */
  referencesTo(workflowId: string): BenchmarkReferenceNode[] {
    assertWorkflowId(workflowId);
    const matches: BenchmarkReferenceNode[] = [];
    const visit = (section: string, path: string[], value: BenchmarkValue): void => {
      if (typeof value !== "object" || value === null) return;
      if (!Array.isArray(value) && Object.hasOwn(value, "workflowId") && value.workflowId === workflowId) {
        matches.push({ section, path, reference: { ...value, workflowId } });
      }
      for (const [name, child] of Object.entries(value)) visit(section, [...path, name], child);
    };
    for (const [section, value] of Object.entries(this.readDocument())) visit(section, [], value);
    return matches;
  }

  private readDocument(): BenchmarkObject {
    if (!existsSync(this.path)) return {};
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.path, "utf8")); }
    catch (error) { throw new Error(`Invalid Workflow benchmarks JSON: ${this.path}`, { cause: error }); }
    assertValue(parsed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      || Object.values(parsed).some((section) => typeof section !== "object" || section === null || Array.isArray(section))) {
      throw new Error(`Invalid benchmarks document; chapters must be objects: ${this.path}`);
    }
    return parsed;
  }
}

function assertAddress(section: string, path: readonly string[]): void {
  for (const segment of [section, ...path]) {
    if (!segment || segment.trim() !== segment || ["__proto__", "prototype", "constructor"].includes(segment)) {
      throw new Error(`Invalid benchmark address segment: ${segment}`);
    }
  }
}

function assertWorkflowId(workflowId: string): void {
  if (!/^workflow-[0-9]{3,}$/.test(workflowId)) throw new Error(`Invalid Workflow reference: ${workflowId}`);
}

/** Validate the JSON boundary and explicit references, not any business schema. */
function assertValue(value: unknown, ancestors = new Set<object>()): asserts value is BenchmarkValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value)
    || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error("Benchmark values must be finite, acyclic JSON values.");
  }
  if (!Array.isArray(value) && Object.hasOwn(value, "workflowId")) {
    const id = Reflect.get(value, "workflowId");
    if (typeof id !== "string") throw new Error("Benchmark Workflow reference must contain a string workflowId.");
    assertWorkflowId(id);
  }
  ancestors.add(value);
  for (const child of Object.values(value)) assertValue(child, ancestors);
  ancestors.delete(value);
}
