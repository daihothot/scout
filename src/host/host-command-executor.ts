import { execFile } from "node:child_process";

/** Input for one direct host-process invocation. */
export interface HostCommandRequest {
  executable: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}

/** Normalized result of a host-process invocation. */
export interface HostCommandResult {
  status: "completed" | "failed" | "timed_out";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

/** One fully observed host-process invocation. */
export interface HostCommandExecution {
  executable: string;
  args: string[];
  cwd: string;
  startedAt: string;
  completedAt: string;
  result: HostCommandResult;
}

/** Executes resolved host commands without interpreting domain-specific output. */
export class HostCommandExecutor {
  run(request: HostCommandRequest): Promise<HostCommandResult> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      execFile(request.executable, [...(request.args ?? [])], {
        cwd: request.cwd,
        env: request.env ?? process.env,
        timeout: request.timeoutMs,
        maxBuffer: request.maxBuffer ?? 2 * 1024 * 1024,
        encoding: "utf8",
      }, (error, stdout, stderr) => {
        const timedOut = error?.killed === true;
        const result: HostCommandResult = {
          status: timedOut ? "timed_out" : error ? "failed" : "completed",
          exitCode: error && typeof error.code === "number" ? error.code : error ? null : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          durationMs: Date.now() - startedAt,
          ...(error ? { error: error.message } : {}),
        };
        resolve(result);
      });
    });
  }
}
