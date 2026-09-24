import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  HostCommandExecutor,
  type HostCommandExecution,
  type HostCommandResult,
} from "../../../../../../host/host-command-executor.js";
import type {
  JarvisBehaviorWebSocketPlatformConnectResult,
  JarvisBehaviorWebSocketPlatformLink,
  JarvisBehaviorWebSocketPlatformLinkInput,
  JarvisBehaviorWebSocketPlatformPrepareResult,
} from "./jarvis-behavior-websocket-platform-link.js";

const BOOTSTRAP_PORT = 18083;
const LOCAL_SERVER_PORT = 8083;
const BOOTSTRAP_TIMEOUT_MS = 15_000;
const BRIDGE_EXIT_TIMEOUT_MS = 5_000;
const BRIDGE_HOLD_MS = 2_147_483_647;

interface BridgeProcess {
  child: ChildProcessWithoutNullStreams;
  listening: Promise<void>;
  target: Promise<string>;
  completed: Promise<HostCommandExecution>;
}

/** Establishes Android's PC bootstrap, reverse mapping and device-server forward mapping. */
export class JarvisBehaviorAndroidWebSocketLink implements JarvisBehaviorWebSocketPlatformLink {
  readonly identity;
  private readonly hostCommands = new HostCommandExecutor();
  private bridge?: BridgeProcess;
  private prepared = false;
  private connected = false;
  private reverseCreated = false;
  private forwardCreated = false;

  constructor(private readonly input: JarvisBehaviorWebSocketPlatformLinkInput) {
    this.identity = structuredClone(input.identity);
  }

  async prepare(): Promise<JarvisBehaviorWebSocketPlatformPrepareResult> {
    const launchParameters = {
      guru_debug: "true",
      guru_ws_client_ip_port: `127.0.0.1:${BOOTSTRAP_PORT}`,
    };
    if (this.prepared) return { ok: true, launchParameters, hostCommands: [] };

    this.bridge = this.startBridge();
    try {
      await withTimeout(
        this.bridge.listening,
        5_000,
        "Jarvis WebSocket bootstrap listener did not become ready.",
      );
    } catch (error) {
      await this.close();
      return failure(
        "websocket_bootstrap_listen_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    const reverse = await this.ensureAdbMapping("reverse", BOOTSTRAP_PORT, BOOTSTRAP_PORT);
    if (!reverse.ok) {
      await this.close();
      return failure(
        reverse.code,
        reverse.message,
        reverse.hostCommands,
      );
    }
    this.reverseCreated = reverse.created;
    this.prepared = true;
    return { ok: true, launchParameters, hostCommands: reverse.hostCommands };
  }

  async connect(): Promise<JarvisBehaviorWebSocketPlatformConnectResult> {
    if (this.connected) {
      return {
        ok: true,
        endpoint: `ws://127.0.0.1:${LOCAL_SERVER_PORT}`,
        hostCommands: [],
      };
    }
    if (!this.prepared || !this.bridge) {
      return failure(
        "websocket_bootstrap_not_prepared",
        "Android WebSocket bootstrap must be prepared before connecting.",
      );
    }

    let target: string;
    try {
      target = await withTimeout(
        this.bridge.target,
        BOOTSTRAP_TIMEOUT_MS,
        "Android did not report its WebSocket server before the bootstrap timeout.",
      );
    } catch (error) {
      return failure(
        "websocket_bootstrap_timeout",
        error instanceof Error ? error.message : String(error),
      );
    }
    const port = targetPort(target);
    if (!port) {
      return failure(
        "websocket_bootstrap_target_invalid",
        `Android reported an invalid WebSocket endpoint: ${target}`,
      );
    }

    const forward = await this.ensureAdbMapping("forward", LOCAL_SERVER_PORT, port);
    if (!forward.ok) {
      return failure(
        forward.code,
        forward.message,
        forward.hostCommands,
      );
    }
    this.forwardCreated = forward.created;
    this.connected = true;
    return {
      ok: true,
      endpoint: `ws://127.0.0.1:${LOCAL_SERVER_PORT}`,
      hostCommands: forward.hostCommands,
    };
  }

  async close(): Promise<void> {
    const bridge = this.bridge;
    this.bridge = undefined;
    if (bridge && bridge.child.exitCode === null && bridge.child.signalCode === null) {
      bridge.child.kill("SIGTERM");
    }
    if (bridge) {
      try {
        await withTimeout(
          bridge.completed,
          BRIDGE_EXIT_TIMEOUT_MS,
          "Jarvis WebSocket bootstrap did not stop before cleanup timed out.",
        );
      } catch {
        bridge.child.kill("SIGKILL");
        await bridge.completed;
      }
    }
    if (this.forwardCreated) {
      await this.runAdb(["forward", "--remove", `tcp:${LOCAL_SERVER_PORT}`], 5_000);
    }
    if (this.reverseCreated) {
      await this.runAdb(["reverse", "--remove", `tcp:${BOOTSTRAP_PORT}`], 5_000);
    }
    this.prepared = false;
    this.connected = false;
    this.forwardCreated = false;
    this.reverseCreated = false;
  }

  private startBridge(): BridgeProcess {
    const args = [
      ...this.input.baseArgs,
      "ws",
      "bridge",
      "--listen-host",
      "127.0.0.1",
      "--listen-port",
      String(BOOTSTRAP_PORT),
      "--announce-host",
      "127.0.0.1",
      "--wait-timeout-ms",
      String(BOOTSTRAP_TIMEOUT_MS),
      "--listen-ms",
      String(BRIDGE_HOLD_MS),
    ];
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const child = spawn(this.input.executable, args, {
      cwd: this.input.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let resolveListening!: () => void;
    let rejectListening!: (error: Error) => void;
    let resolveTarget!: (target: string) => void;
    let rejectTarget!: (error: Error) => void;
    let listeningSettled = false;
    let targetSettled = false;
    const listening = new Promise<void>((resolve, reject) => {
      resolveListening = resolve;
      rejectListening = reject;
    });
    const target = new Promise<string>((resolve, reject) => {
      resolveTarget = resolve;
      rejectTarget = reject;
    });
    void target.catch(() => undefined);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      stdout += `${line}\n`;
      if (!listeningSettled && line.includes("[WS][BRIDGE] listening on")) {
        listeningSettled = true;
        resolveListening();
      }
      const marker = "[WS][BRIDGE] target websocket: ";
      if (!targetSettled && line.startsWith(marker)) {
        targetSettled = true;
        resolveTarget(line.slice(marker.length).trim());
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const completed = new Promise<HostCommandExecution>((resolve) => {
      child.once("error", (error) => {
        if (!listeningSettled) rejectListening(error);
        if (!targetSettled) rejectTarget(error);
      });
      child.once("close", (code, signal) => {
        lines.close();
        const detail = stderr.trim() || `Bridge exited with code ${String(code)} and signal ${String(signal)}.`;
        if (!listeningSettled) rejectListening(new Error(detail));
        if (!targetSettled) rejectTarget(new Error(detail));
        const failed = code !== 0;
        resolve({
          executable: this.input.executable,
          args,
          cwd: this.input.cwd,
          startedAt,
          completedAt: new Date().toISOString(),
          result: {
            status: failed ? "failed" : "completed",
            exitCode: code,
            stdout,
            stderr,
            durationMs: Date.now() - startedMs,
            ...(failed ? { error: detail } : {}),
          },
        });
      });
    });
    return { child, listening, target, completed };
  }

  private async runAdb(args: string[], timeoutMs: number): Promise<HostCommandExecution> {
    const startedAt = new Date().toISOString();
    const result = await this.hostCommands.run({
      executable: "adb",
      args,
      cwd: this.input.cwd,
      env: process.env,
      timeoutMs,
    });
    return {
      executable: "adb",
      args,
      cwd: this.input.cwd,
      startedAt,
      completedAt: new Date().toISOString(),
      result,
    };
  }

  private async ensureAdbMapping(
    kind: "forward" | "reverse",
    localPort: number,
    remotePort: number,
  ): Promise<
    | { ok: true; created: boolean; hostCommands: HostCommandExecution[] }
    | { ok: false; code: string; message: string; hostCommands: HostCommandExecution[] }
  > {
    const list = await this.runAdb([kind, "--list"], 5_000);
    const hostCommands = [list];
    if (list.result.status !== "completed") {
      return {
        ok: false,
        code: `websocket_${kind}_inspect_failed`,
        message: list.result.error ?? (list.result.stderr.trim() || `ADB ${kind} inspection failed.`),
        hostCommands,
      };
    }
    const local = `tcp:${localPort}`;
    const remote = `tcp:${remotePort}`;
    const existing = list.result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .find((parts) => parts.length >= 3 && parts.at(-2) === local);
    if (existing) {
      if (existing.at(-1) === remote) return { ok: true, created: false, hostCommands };
      return {
        ok: false,
        code: `websocket_${kind}_conflict`,
        message: `ADB ${kind} ${local} is already mapped to ${existing.at(-1) ?? "another endpoint"}.`,
        hostCommands,
      };
    }

    const create = await this.runAdb([kind, local, remote], 5_000);
    hostCommands.push(create);
    if (create.result.status !== "completed") {
      return {
        ok: false,
        code: `websocket_${kind}_failed`,
        message: create.result.error ?? (create.result.stderr.trim() || `ADB ${kind} mapping failed.`),
        hostCommands,
      };
    }
    return { ok: true, created: true, hostCommands };
  }
}

function failure(
  code: string,
  message: string,
  hostCommands: HostCommandExecution[] = [],
) {
  return { ok: false as const, code, message, hostCommands };
}

function targetPort(target: string): number | undefined {
  try {
    const port = Number.parseInt(new URL(target).port, 10);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
  } catch {
    return undefined;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
