import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CodexMount } from "../contracts/mount.js";
import {
  buildMountShellEnvironment,
  buildMountShellPath,
} from "./macros.js";

export interface MountRootAccessReport {
  status: "passed" | "failed";
  roots: Array<{
    path: string;
    access: "readable" | "writable";
    status: "passed" | "failed";
    error?: string;
  }>;
}

export interface MountShellSmokeResult {
  command: string;
  status: "passed" | "failed";
  durationMs: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

interface MountShellSmokeBatch {
  run: Map<string, Promise<MountShellSmokeResult>>;
  schedule(operation: () => Promise<MountShellSmokeResult>): Promise<MountShellSmokeResult>;
}

/** Returns the Agent-shell readable roots owned by runtime and the role profile. */
export function collectMountReadableRoots(mount: CodexMount): string[] {
  return uniqueStrings([
    mount.mountRoot,
    ...mount.readableRoots,
  ]);
}

/** Returns unique writable roots required by the mount and its MCP servers. */
export function collectMountWritableRoots(mount: CodexMount): string[] {
  return uniqueStrings([
    mount.artifactRoot,
    mount.tempRoot,
    ...mount.writableRoots,
    ...mount.mcpServers.flatMap((server) => server.writableRoots),
  ]);
}

/** Checks every readable and writable root declared by one prepared mount. */
export function inspectMountRootAccess(mount: CodexMount): MountRootAccessReport {
  const writableRoots = new Set(collectMountWritableRoots(mount));
  const readableRoots = new Set(collectMountReadableRoots(mount));
  const roots = [...new Set([
    ...readableRoots,
    ...writableRoots,
  ])].map((path) => {
    const access = writableRoots.has(path) ? "writable" as const : "readable" as const;
    try {
      if (!statSync(path).isDirectory()) {
        throw new Error("path is not a directory");
      }
      accessSync(
        path,
        constants.R_OK | (access === "writable" ? constants.W_OK : 0),
      );
      return { path, access, status: "passed" as const };
    } catch (error) {
      return {
        path,
        access,
        status: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  return {
    status: roots.every((root) => root.status === "passed") ? "passed" : "failed",
    roots,
  };
}

/** Creates a run-scoped shell-tool preflight with bounded concurrency and shared smokes. */
export function createMountShellPreflight(
  concurrency: number,
): (mount: CodexMount) => Promise<MountShellSmokeResult[]> {
  const batch = createMountShellSmokeBatch(concurrency);
  return (mount) => smokeMountShellTools(mount, batch);
}

function createMountShellSmokeBatch(concurrency: number): MountShellSmokeBatch {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Shell smoke concurrency must be a positive integer: ${concurrency}`);
  }
  const waiters: Array<() => void> = [];
  let active = 0;
  return {
    run: new Map(),
    schedule: async (operation) => {
      if (active < concurrency) {
        active += 1;
      } else {
        await new Promise<void>((resolveWaiter) => waiters.push(resolveWaiter));
      }
      try {
        return await operation();
      } finally {
        const next = waiters.shift();
        if (next) next();
        else active -= 1;
      }
    },
  };
}

async function smokeMountShellTools(
  mount: CodexMount,
  batch: MountShellSmokeBatch,
): Promise<MountShellSmokeResult[]> {
  const mountRoot = mount.mountRoot;
  const tools = mount.shellTools.filter((tool) => tool.required);
  const environment = {
    ...process.env,
    PATH: buildMountShellPath(mountRoot),
    ...buildMountShellEnvironment({
      runRoot: mount.runRoot,
      artifactRoot: mount.artifactRoot,
      tempRoot: mount.tempRoot,
      hostTempRoot: tmpdir(),
      assetCommitId: mount.assetCommitId,
    }),
  };
  return Promise.all(tools.map(async (tool): Promise<MountShellSmokeResult> => {
    const startedAt = Date.now();
    const command = [tool.exposeAs, ...(tool.smoke?.args ?? [])].join(" ");
    const executable = join(mountRoot, "bin", tool.exposeAs);

    try {
      accessSync(executable, constants.X_OK);
    } catch (error) {
      return {
        command,
        status: "failed",
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!tool.smoke) {
      return {
        command,
        status: "passed",
        durationMs: Date.now() - startedAt,
      };
    }
    const smoke = tool.smoke;

    const execute = () => new Promise<MountShellSmokeResult>((resolveOutput) => {
      const finish = (result: Omit<MountShellSmokeResult, "durationMs">) => {
        resolveOutput({
          ...result,
          durationMs: Date.now() - startedAt,
        });
      };
      const runCodegraph = (codebasePath: string) => {
        const args = [...smoke.args, codebasePath];
        execFile(executable, args, {
          cwd: mountRoot,
          env: environment,
          encoding: "utf8",
        }, (error, stdout, stderr) => {
          const normalizedStdout = String(stdout).trim();
          const normalizedStderr = String(stderr).trim();
          const markerPassed = smoke.marker
            ? normalizedStdout.includes(smoke.marker)
            : true;
          const passed = !error && markerPassed;
          finish({
            command: [tool.exposeAs, ...args].join(" "),
            status: passed ? "passed" : "failed",
            stdout: normalizedStdout,
            stderr: normalizedStderr,
            ...(!passed ? {
              error: error?.message ?? `Missing marker: ${smoke.marker}`,
            } : {}),
          });
        });
      };

      if (!smoke.managedCodebase) {
        execFile(executable, smoke.args, {
          cwd: mountRoot,
          env: environment,
          encoding: "utf8",
        }, (error, stdout, stderr) => {
          const normalizedStdout = String(stdout).trim();
          const normalizedStderr = String(stderr).trim();
          const markerPassed = smoke.marker
            ? normalizedStdout.includes(smoke.marker)
            : true;
          const passed = !error && markerPassed;
          finish({
            command,
            status: passed ? "passed" : "failed",
            stdout: normalizedStdout,
            stderr: normalizedStderr,
            ...(!passed ? {
              error: error?.message ?? `Missing marker: ${smoke.marker}`,
            } : {}),
          });
        });
        return;
      }

      const jarvisTool = mount.shellTools.find((candidate) =>
        candidate.id === "jarvis-codebase"
      );
      if (!jarvisTool) {
        finish({
          command,
          status: "failed",
          error: "Managed CodeGraph smoke requires the jarvis-codebase shell tool.",
        });
        return;
      }
      const jarvisExecutable = join(mountRoot, "bin", jarvisTool.exposeAs);
      execFile(jarvisExecutable, [smoke.managedCodebase, "path"], {
        cwd: mountRoot,
        env: environment,
        encoding: "utf8",
      }, (error, stdout, stderr) => {
        const normalizedStdout = String(stdout).trim();
        const normalizedStderr = String(stderr).trim();
        if (error) {
          finish({
            command,
            status: "failed",
            stdout: normalizedStdout,
            stderr: normalizedStderr,
            error: `Jarvis managed codebase path failed: ${error.message}`,
          });
          return;
        }
        const codebasePath = normalizedStdout.split(/\r?\n/).at(-1)?.trim() ?? "";
        if (!isAbsolute(codebasePath)) {
          finish({
            command,
            status: "failed",
            stdout: normalizedStdout,
            stderr: normalizedStderr,
            error: `Jarvis returned a non-absolute managed codebase path: ${codebasePath}`,
          });
          return;
        }
        try {
          if (!statSync(codebasePath).isDirectory()) {
            throw new Error("path is not a directory");
          }
        } catch (pathError) {
          finish({
            command,
            status: "failed",
            stdout: normalizedStdout,
            stderr: normalizedStderr,
            error: `Jarvis returned an unusable managed codebase path: ${pathError instanceof Error ? pathError.message : String(pathError)}`,
          });
          return;
        }
        runCodegraph(codebasePath);
      });
    });

    if (smoke.scope === "mount") return batch.schedule(execute);

    const cacheKey = JSON.stringify({
      id: tool.id,
      command: tool.command,
      args: tool.args ?? [],
      exposeAs: tool.exposeAs,
      smoke,
    });
    const existing = batch.run.get(cacheKey);
    if (existing) return existing;
    const execution = batch.schedule(execute);
    batch.run.set(cacheKey, execution);
    return execution;
  }));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
