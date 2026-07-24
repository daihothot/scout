import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ScoutAgentRole } from "../../agent/thread/types.js";

export interface RunAgentManifestEntry {
  mountId: string;
  assetCommitId: string;
  resourceHash: string;
  mountManifestRef: string;
  assetCommitRef: string;
  preflightRef: string;
}

export interface RunManifest {
  version: 2;
  runId: string;
  repoRoot: string;
  createdAt: string;
  updatedAt: string;
  runtime: {
    status: "created" | "attached" | "ready" | "detached" | "interrupted";
    mode?: "start" | "resume";
    processId?: number;
    reason?: string;
  };
  checkpointSeq: number;
  agents?: Record<ScoutAgentRole, RunAgentManifestEntry>;
}

export class RunManifestStore {
  readonly path: string;

  constructor(runRoot: string) {
    this.path = join(runRoot, "run.json");
  }

  create(input: {
    runId: string;
    repoRoot: string;
    createdAt: string;
    checkpointSeq: number;
  }): RunManifest {
    const manifest: RunManifest = {
      version: 2,
      runId: input.runId,
      repoRoot: resolve(input.repoRoot),
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      runtime: { status: "created" },
      checkpointSeq: input.checkpointSeq,
    };
    this.write(manifest);
    return structuredClone(manifest);
  }

  read(): RunManifest {
    const manifest = JSON.parse(readFileSync(this.path, "utf8")) as RunManifest;
    if (manifest.version !== 2 || typeof manifest.runId !== "string") {
      throw new Error(`Unsupported run manifest: ${this.path}`);
    }
    return structuredClone(manifest);
  }

  update(update: (manifest: RunManifest) => RunManifest): RunManifest {
    const current = this.read();
    const next = update(current);
    if (next.runId !== current.runId) {
      throw new Error(`Cannot change run id from ${current.runId} to ${next.runId}.`);
    }
    const stored = {
      ...next,
      updatedAt: new Date().toISOString(),
    };
    this.write(stored);
    return structuredClone(stored);
  }

  private write(manifest: RunManifest): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, this.path);
  }
}
