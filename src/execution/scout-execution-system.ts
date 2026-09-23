import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface ExecutionPlatformIdentity {
  type: string;
  version: string;
}

export interface ExecutionPlatformFailure {
  ok: false;
  code: string;
  message: string;
  requiresIdentify?: true;
}

export type ExecutionPlatformLaunchResult =
  | { ok: true; identity: ExecutionPlatformIdentity }
  | ExecutionPlatformFailure;

export type ExecutionPlatformShutdownResult =
  | { ok: true; identity: ExecutionPlatformIdentity }
  | ExecutionPlatformFailure;

export interface ExecutionPlatformPort {
  launch(): Promise<ExecutionPlatformLaunchResult>;
  shutdown(): Promise<ExecutionPlatformShutdownResult>;
}

type AppPilotWireValue =
  | null
  | boolean
  | number
  | string
  | AppPilotWireValue[]
  | { [key: string]: AppPilotWireValue };

type AppPilotResponse =
  | { id: string; ok: true; value?: AppPilotWireValue }
  | { id: string; ok: false; code: string; message: string; requiresIdentify?: true };

interface AppPilotProcessHandle {
  invoke(args: readonly string[]): Promise<AppPilotResponse>;
  close(): Promise<void>;
}

export interface ScoutExecutionSystemStartOptions {
  cwd: string;
  executable?: string;
  baseArgs?: readonly string[];
  startupTimeoutMs?: number;
}

/** Owns the current run's AppPilot process and physical execution session. */
export class ScoutExecutionSystem implements ExecutionPlatformPort {
  private identity?: ExecutionPlatformIdentity;
  private operationTail: Promise<void> = Promise.resolve();
  private disposePromise?: Promise<void>;
  private disposed = false;

  constructor(private readonly appPilot: AppPilotProcessHandle) {}

  static async start(options: ScoutExecutionSystemStartOptions): Promise<ScoutExecutionSystem> {
    return new ScoutExecutionSystem(await AppPilotProcess.start(options));
  }

  launch(): Promise<ExecutionPlatformLaunchResult> {
    if (this.disposed) return Promise.resolve(disposedFailure());
    return this.enqueue(async () => {
      const identity = await this.ensureSession();
      if (!identity.ok) return identity;
      const launched = await this.invoke(["launch"]);
      if (!launched.ok) return launched;
      return { ok: true, identity: structuredClone(identity.value) };
    });
  }

  shutdown(): Promise<ExecutionPlatformShutdownResult> {
    if (this.disposed) return Promise.resolve(disposedFailure());
    return this.enqueue(async () => {
      const identity = await this.ensureSession();
      if (!identity.ok) return identity;
      const stopped = await this.invoke(["shutdown"]);
      if (!stopped.ok) return stopped;
      this.identity = undefined;
      return { ok: true, identity: structuredClone(identity.value) };
    });
  }

  /** Stops an owned session and then closes the run-owned AppPilot process. */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.enqueue(async () => {
      let shutdownFailure: ExecutionPlatformFailure | undefined;
      try {
        if (this.identity) {
          const stopped = await this.invoke(["shutdown"]);
          if (!stopped.ok) shutdownFailure = stopped;
          this.identity = undefined;
        }
      } finally {
        await this.appPilot.close();
      }
      if (shutdownFailure) {
        throw new Error(`${shutdownFailure.code}: ${shutdownFailure.message}`);
      }
    });
    return this.disposePromise;
  }

  private async ensureSession(): Promise<
    | { ok: true; value: ExecutionPlatformIdentity }
    | ExecutionPlatformFailure
  > {
    if (this.identity) return { ok: true, value: this.identity };
    const identified = await this.invoke(["identify", "--transport", "unity-pipeline"]);
    if (!identified.ok) return identified;
    const identity = parseIdentity(identified.value);
    if (!identity) {
      return {
        ok: false,
        code: "apppilot_invalid_response",
        message: "AppPilot identify returned an invalid Unity Pipeline identity.",
      };
    }
    this.identity = identity;
    return { ok: true, value: identity };
  }

  private async invoke(args: readonly string[]): Promise<
    | { ok: true; value?: AppPilotWireValue }
    | ExecutionPlatformFailure
  > {
    try {
      const response = await this.appPilot.invoke(args);
      if (response.ok) {
        return {
          ok: true,
          ...(response.value !== undefined ? { value: response.value } : {}),
        };
      }
      if (response.requiresIdentify) this.identity = undefined;
      return {
        ok: false,
        code: response.code,
        message: response.message,
        ...(response.requiresIdentify ? { requiresIdentify: true } : {}),
      };
    } catch (error) {
      this.identity = undefined;
      return {
        ok: false,
        code: "apppilot_process_unavailable",
        message: error instanceof Error ? error.message : String(error),
        requiresIdentify: true,
      };
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Owns one AppPilot child process and its request-response channel. */
class AppPilotProcess implements AppPilotProcessHandle {
  private readonly pending = new Map<string, {
    resolve: (response: AppPilotResponse) => void;
    reject: (error: Error) => void;
  }>();
  private readonly readyPromise: Promise<void>;
  private readonly closedPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveClosed!: () => void;
  private stderr = "";
  private ready = false;
  private closed = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.acceptLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8_192);
    });
    child.once("error", (error) => this.fail(error));
    child.once("close", (code, signal) => {
      this.closed = true;
      lines.close();
      const detail = this.stderr.trim();
      const error = new Error(
        `AppPilot process exited (code=${String(code)}, signal=${String(signal)})${detail ? `: ${detail}` : "."}`,
      );
      if (!this.ready) this.rejectReady(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.resolveClosed();
    });
  }

  static async start(options: ScoutExecutionSystemStartOptions): Promise<AppPilotProcess> {
    const executable = options.executable ?? join(
      options.cwd,
      "assets",
      "codex",
      "plugins",
      "apppilot",
      "runtime",
      "apppilot",
    );
    const child = spawn(executable, [...(options.baseArgs ?? []), "--stdio"], {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const instance = new AppPilotProcess(child);
    const timeoutMs = options.startupTimeoutMs ?? 10_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        instance.readyPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`AppPilot process did not become ready within ${timeoutMs} ms.`)),
            timeoutMs,
          );
        }),
      ]);
      return instance;
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  invoke(args: readonly string[]): Promise<AppPilotResponse> {
    if (!this.ready || this.closed) {
      return Promise.reject(new Error("AppPilot process is not available."));
    }
    const id = randomUUID();
    return new Promise<AppPilotResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, args: [...args] }) + "\n", (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 5_000);
    try {
      await this.closedPromise;
    } finally {
      clearTimeout(timer);
    }
  }

  private acceptLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.fail(new Error("AppPilot process returned a non-JSON response."));
      return;
    }
    if (isRecord(value) && value.type === "ready" && value.protocolVersion === 1) {
      if (!this.ready) {
        this.ready = true;
        this.resolveReady();
      }
      return;
    }
    const response = parseResponse(value);
    if (!response) {
      this.fail(new Error("AppPilot process returned an invalid response."));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    pending.resolve(response);
  }

  private fail(error: Error): void {
    if (!this.ready) this.rejectReady(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function parseIdentity(value: AppPilotWireValue | undefined): ExecutionPlatformIdentity | undefined {
  if (!isRecord(value)
    || value.transport !== "unity-pipeline"
    || !isRecord(value.platform)
    || value.platform.type !== "unity_editor"
    || typeof value.platform.version !== "string"
    || value.platform.version.length === 0) {
    return undefined;
  }
  return { type: value.platform.type, version: value.platform.version };
}

function parseResponse(value: unknown): AppPilotResponse | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.ok !== "boolean") {
    return undefined;
  }
  if (value.ok) {
    if (!("value" in value)) return { id: value.id, ok: true };
    return isWireValue(value.value) ? { id: value.id, ok: true, value: value.value } : undefined;
  }
  if (typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  if (value.requiresIdentify !== undefined && value.requiresIdentify !== true) return undefined;
  return {
    id: value.id,
    ok: false,
    code: value.code,
    message: value.message,
    ...(value.requiresIdentify ? { requiresIdentify: true } : {}),
  };
}

function isWireValue(value: unknown): value is AppPilotWireValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isWireValue);
  return isRecord(value) && Object.values(value).every(isWireValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function disposedFailure(): ExecutionPlatformFailure {
  return {
    ok: false,
    code: "execution_system_disposed",
    message: "The Scout execution system has been disposed.",
  };
}
