/**
 * Owns the long-lived JSON-RPC connection to one Codex app-server process.
 * It translates Scout's thread/turn operations into protocol requests, reduces
 * incoming notifications through the event store, and exposes subscription
 * points for runtime observers. It does not decide agent policy or materialize
 * a workspace; those decisions belong to run stages and the asset store.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import readline from "node:readline";
import {
  AppServerEventStore,
  type AppServerEventStoreSnapshot,
  type AppServerPlanState,
  type AppServerProgressItem,
  type AppServerResolvedTimelineEntry,
  type AppServerThreadGoalState,
  type AppServerThreadState,
  type AppServerTimelineEntry,
  type AppServerTimelineStream,
  type AppServerTurnState,
} from "./app-server-event-store.js";
import {
  type CodexReasoningEffort,
  type CodexReasoningSummary,
} from "./model-config.js";
import type { DynamicToolCallResponse } from "../types.js";

/** A successful or failed response to a client-issued JSON-RPC request. */
export interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** A server notification that has no request/response pairing. */
export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

/** A server-initiated request that Scout must answer on the same connection. */
export interface JsonRpcServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

/** The three message shapes accepted by the app-server receive loop. */
export type JsonRpcMessage =
  | JsonRpcResponse
  | JsonRpcNotification
  | JsonRpcServerRequest;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface TurnWaiter {
  finalResponse: string;
  statusMessages: Set<string>;
  timeout?: NodeJS.Timeout;
  onStatusMessage?: (message: string) => void;
  resolve: (value: TurnOutput) => void;
  reject: (error: Error) => void;
}

type AppServerExclusiveOperation = "plugin-manager";

/** The protocol turn identifier returned after a `turn/start` request. */
export interface TurnStartResponse {
  turnId: string;
  response: unknown;
}

/** Response returned after appending input to an already active turn. */
export interface TurnSteerResponse {
  turnId: string;
  response: unknown;
}

/** Process, environment, and diagnostic paths used to launch one app-server. */
export interface CodexAppServerOptions {
  codexPath?: string;
  home: string;
  codexHome: string;
  providerName?: string;
  providerApiKey?: string;
  logPrefix?: string;
  stderrLogPath?: string;
  transportLogPath?: string;
  /** Controls whether child diagnostics are also copied to the terminal. */
  writeDiagnosticsToStderr?: boolean;
  onDynamicToolCall?: DynamicToolCallHandler;
}

/** Optional Scout-facing inputs used to construct a `thread/start` request. */
export interface ThreadStartOptions {
  cwd: string;
  runtimeWorkspaceRoots?: string[];
  model?: string;
  modelProvider?: string;
  reasoningEffort?: CodexReasoningEffort;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  permissions: string;
  ephemeral?: boolean;
  config?: Record<string, unknown>;
  baseInstructions?: string;
  developerInstructions?: string;
  dynamicTools?: DynamicToolSpec[];
}

/** Normalized `thread/start` payload sent to Codex after defaults are applied. */
export interface ThreadStartRequest {
  cwd: string;
  runtimeWorkspaceRoots?: string[];
  model?: string;
  modelProvider?: string;
  approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
  permissions: string;
  ephemeral: boolean;
  config?: Record<string, unknown>;
  baseInstructions?: string;
  developerInstructions?: string;
  dynamicTools?: DynamicToolSpec[];
}

/** Protocol response plus the exact normalized start input for persistence. */
export interface ThreadStartResponse {
  threadId: string;
  startInput: ThreadStartRequest;
  response: unknown;
}

/** Optional overrides used when reattaching a persisted Codex thread. */
export interface ThreadResumeOptions {
  threadId: string;
  path?: string;
  cwd?: string;
  runtimeWorkspaceRoots?: string[];
  model?: string;
  modelProvider?: string;
  reasoningEffort?: CodexReasoningEffort;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  permissions: string;
  config?: Record<string, unknown>;
  baseInstructions?: string;
  developerInstructions?: string;
}

/** Normalized `thread/resume` payload; turns are excluded because Scout rebuilds projections. */
export interface ThreadResumeRequest {
  threadId: string;
  excludeTurns: true;
  path?: string;
  cwd?: string;
  runtimeWorkspaceRoots?: string[];
  model?: string;
  modelProvider?: string;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  permissions: string;
  config?: Record<string, unknown>;
  baseInstructions?: string;
  developerInstructions?: string;
}

/** Resume response together with the input whose paths and settings were checked. */
export interface ThreadResumeResponse {
  threadId: string;
  resumeInput: ThreadResumeRequest;
  response: unknown;
}

/** Prompt and execution policy for one Codex turn. */
export interface TurnStartOptions {
  threadId: string;
  prompt: string;
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  reasoningSummary?: CodexReasoningSummary;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  permissions: string;
  onStatusMessage?: (message: string) => void;
  onTurnStarted?: (turnId: string) => void;
}

/** Reduced turn result assembled from completion notification and event-store state. */
export interface TurnOutput {
  turnId?: string;
  finalResponse: string;
  response: unknown;
  startResponse?: unknown;
  eventStoreSnapshot?: AppServerEventStoreSnapshot;
  turnSnapshot?: AppServerTurnState;
  progressItems?: AppServerProgressItem[];
  plan?: AppServerEventStoreSnapshot["threads"][string]["plan"];
  goal?: AppServerThreadGoalState;
}

/** Schema and presentation metadata advertised for a Scout dynamic tool. */
export interface DynamicToolSpec {
  namespace?: string;
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
}

/** Identifiers and arguments supplied by Codex for a dynamic-tool invocation. */
export interface DynamicToolCallInput {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

/** Callback that executes a dynamic tool and returns protocol content items. */
export type DynamicToolCallHandler = (
  input: DynamicToolCallInput,
) => Promise<DynamicToolCallResponse> | DynamicToolCallResponse;

/** Observer invoked for every raw app-server notification. */
export type AppServerNotificationHandler = (
  notification: JsonRpcNotification,
) => void;

/** Reply capability handed to a server-request handler. */
export interface AppServerRequestController {
  sendResult(result: unknown): void;
  sendError(code: number, message: string): void;
}

/** Handler for server requests that can claim a request by returning true. */
export type AppServerRequestHandler = (
  request: JsonRpcServerRequest,
  controller: AppServerRequestController,
) => boolean | Promise<boolean>;

/** Observer invoked after an incoming message passes the JSON-RPC shape gate. */
export type AppServerMessageHandler = (message: JsonRpcMessage) => void;
/** Observer invoked for timeline entries reduced by the event store. */
export type AppServerTimelineHandler = (entry: AppServerTimelineEntry) => void;

/**
 * Runs one Codex app-server child process and presents its protocol as typed
 * thread/turn operations. It owns request correlation, disconnect rejection,
 * and observer cleanup; lifecycle stages own when the client is created or
 * closed, while the event store owns durable in-memory projections.
 */
export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly exclusiveOperationTails = new Map<
    AppServerExclusiveOperation,
    Promise<void>
  >();
  private readonly messageHandlers = new Set<AppServerMessageHandler>();
  private readonly notificationHandlers = new Set<AppServerNotificationHandler>();
  private readonly serverRequestHandlers = new Set<AppServerRequestHandler>();
  private readonly timelineHandlers = new Set<AppServerTimelineHandler>();
  private readonly eventStore = new AppServerEventStore();
  private readonly logPrefix: string;
  private readonly codexHome: string;
  private readonly stderrLogPath?: string;
  private readonly transportLogPath?: string;
  private readonly writeDiagnosticsToStderr: boolean;
  private onDynamicToolCall?: DynamicToolCallHandler;
  private nextRequestId = 1;
  private closing = false;

  constructor(options: CodexAppServerOptions) {
    const provider = readProviderConfig(options.providerName ?? "GuruOpenAI");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: options.home,
      CODEX_HOME: options.codexHome,
    };
    if (options.providerApiKey) {
      env.CODEX_API_KEY = options.providerApiKey;
    } else if (provider.envKey && process.env[provider.envKey]) {
      env.CODEX_API_KEY = process.env[provider.envKey];
    }
    if (provider.baseUrl) {
      env.OPENAI_BASE_URL = provider.baseUrl;
    }

    this.logPrefix = options.logPrefix ?? "scout app-server";
    this.codexHome = resolve(options.codexHome);
    this.stderrLogPath = options.stderrLogPath;
    this.transportLogPath = options.transportLogPath;
    // Ink owns an interactive stdout terminal. Raw child stderr would bypass
    // its layout and be written at the current terminal cursor position.
    this.writeDiagnosticsToStderr = options.writeDiagnosticsToStderr
      ?? !process.stdout.isTTY;
    if (this.stderrLogPath) mkdirSync(dirname(this.stderrLogPath), { recursive: true });
    if (this.transportLogPath) mkdirSync(dirname(this.transportLogPath), { recursive: true });
    this.onDynamicToolCall = options.onDynamicToolCall;
    this.child = spawn(options.codexPath ?? provider.codexCliPath ?? "codex", ["app-server"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      this.writeDiagnostic(chunk.toString("utf8"));
    });
    this.child.once("exit", (code, signal) => {
      if (this.closing) return;
      const message = `Codex app-server exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}.`;
      this.writeDiagnostic(message);
      this.handleDisconnect(message);
      this.rejectAll(new Error(message));
    });
    this.child.once("error", (error) => {
      if (this.closing) return;
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.writeDiagnostic(normalized.stack ?? normalized.message);
      this.handleDisconnect(normalized.message);
      this.rejectAll(normalized);
    });

    this.startReceiveLoop();
  }

  /** Performs the protocol handshake before thread operations are allowed. */
  async startSession(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "scout-runtime",
        title: "Scout Runtime",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  /** Starts a new Codex thread and returns the normalized request for recording. */
  async startThread(options: ThreadStartOptions): Promise<ThreadStartResponse> {
    const startInput: ThreadStartRequest = cleanUndefined({
      model: options.model,
      modelProvider: options.modelProvider,
      cwd: options.cwd,
      runtimeWorkspaceRoots: options.runtimeWorkspaceRoots,
      approvalPolicy: options.approvalPolicy ?? "never",
      permissions: options.permissions,
      ephemeral: options.ephemeral ?? true,
      config: options.reasoningEffort === undefined
        ? options.config
        : {
            ...(options.config ?? {}),
            model_reasoning_effort: options.reasoningEffort,
          },
      baseInstructions: options.baseInstructions,
      developerInstructions: options.developerInstructions,
      dynamicTools: options.dynamicTools,
    });
    const response = await this.request("thread/start", startInput);
    assertActivePermissionProfile(response, options.permissions, "started thread");
    return {
      threadId: readNestedString(response, ["thread", "id"]),
      startInput,
      response,
    };
  }

  /** Resumes a persisted thread and fail-closes when Codex confirms different identity or paths. */
  async resumeThread(options: ThreadResumeOptions): Promise<ThreadResumeResponse> {
    const resumeInput: ThreadResumeRequest = cleanUndefined({
      threadId: options.threadId,
      excludeTurns: true as const,
      path: options.path,
      model: options.model,
      modelProvider: options.modelProvider,
      cwd: options.cwd,
      runtimeWorkspaceRoots: options.runtimeWorkspaceRoots,
      approvalPolicy: options.approvalPolicy,
      permissions: options.permissions,
      config: options.reasoningEffort === undefined
        ? options.config
        : {
            ...(options.config ?? {}),
            model_reasoning_effort: options.reasoningEffort,
          },
      baseInstructions: options.baseInstructions,
      developerInstructions: options.developerInstructions,
    });
    const response = await this.request("thread/resume", resumeInput);
    const responseObject = readObject(response);
    const thread = readObject(responseObject.thread);
    const threadId = readString(thread, "id");
    if (threadId !== options.threadId) {
      throw new Error(
        `Codex resumed thread ${threadId}, expected ${options.threadId}.`,
      );
    }
    const assertResponseString = (key: string, expected: string | undefined): void => {
      if (expected === undefined) return;
      const actual = readString(responseObject, key);
      if (actual !== expected) {
        throw new Error(
          `Codex resumed thread ${threadId} with ${key} ${actual}, expected ${expected}.`,
        );
      }
    };
    assertResponseString("cwd", options.cwd);
    assertResponseString("model", options.model);
    assertResponseString("modelProvider", options.modelProvider);
    assertResponseString("approvalPolicy", options.approvalPolicy);
    assertActivePermissionProfile(responseObject, options.permissions, `resumed thread ${threadId}`);
    if (options.runtimeWorkspaceRoots !== undefined) {
      const actualRoots = responseObject.runtimeWorkspaceRoots;
      if (!Array.isArray(actualRoots)
        || actualRoots.some((root) => typeof root !== "string")
        || actualRoots.length !== options.runtimeWorkspaceRoots.length
        || options.runtimeWorkspaceRoots.some((root) => !actualRoots.includes(root))) {
        throw new Error(
          `Codex resumed thread ${threadId} with unexpected runtime workspace roots.`,
        );
      }
    }
    if (options.path !== undefined) {
      const actualPath = readString(thread, "path");
      const expectedPath = isAbsolute(options.path)
        ? resolve(options.path)
        : resolve(this.codexHome, options.path);
      const normalizedActualPath = isAbsolute(actualPath)
        ? resolve(actualPath)
        : resolve(this.codexHome, actualPath);
      if (normalizedActualPath !== expectedPath) {
        throw new Error(
          `Codex resumed thread ${threadId} from ${actualPath}, expected ${expectedPath}.`,
        );
      }
    }
    return {
      threadId,
      resumeInput,
      response,
    };
  }

  /** Starts one turn and waits for its completion projection, cancelling the waiter on start failure. */
  async runTurn(options: TurnStartOptions): Promise<TurnOutput> {
    const completion = this.awaitTurnCompletion({
      threadId: options.threadId,
      timeoutMs: options.timeoutMs,
      onStatusMessage: options.onStatusMessage,
    });
    let start: TurnStartResponse;
    try {
      start = await this.startTurn(options);
      options.onTurnStarted?.(start.turnId);
    } catch (error) {
      completion.catch(() => undefined);
      this.cancelTurnWait(
        options.threadId,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
    const result = await completion;
    return {
      ...result,
      turnId: result.turnId ?? start.turnId,
      startResponse: start.response,
      response: result.response ?? start.response,
    };
  }

  /** Sends a `turn/start` request with the role's named permission profile. */
  async startTurn(options: TurnStartOptions): Promise<TurnStartResponse> {
    const response = await this.request("turn/start", cleanUndefined({
      threadId: options.threadId,
      input: [{ type: "text", text: options.prompt, text_elements: [] }],
      approvalPolicy: options.approvalPolicy ?? "never",
      permissions: options.permissions,
      model: options.model,
      effort: options.reasoningEffort,
      summary: options.reasoningSummary,
    }));
    return {
      turnId: readTurnId(response),
      response,
    };
  }

  /** Appends user input to the currently active turn without creating a turn. */
  async steerTurn(input: {
    threadId: string;
    expectedTurnId: string;
    prompt: string;
    clientUserMessageId?: string;
  }): Promise<TurnSteerResponse> {
    const response = await this.request("turn/steer", cleanUndefined({
      threadId: input.threadId,
      expectedTurnId: input.expectedTurnId,
      clientUserMessageId: input.clientUserMessageId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
    }));
    const turnId = readTurnId(response) ?? input.expectedTurnId;
    return {
      turnId,
      response,
    };
  }

  /** Requests interruption of a currently running turn. */
  async interruptTurn(input: {
    threadId: string;
    turnId: string;
  }): Promise<unknown> {
    return this.request("turn/interrupt", {
      threadId: input.threadId,
      turnId: input.turnId,
    });
  }

  /** Persists a thread goal through Codex and returns the reduced goal state when available. */
  async setThreadGoal(input: {
    threadId: string;
    objective: string;
    tokenBudget?: number;
  }): Promise<AppServerThreadGoalState | undefined> {
    const response = await this.request("thread/goal/set", cleanUndefined({
      threadId: input.threadId,
      objective: input.objective,
      tokenBudget: input.tokenBudget,
    }));
    const snapshot = this.eventStore.threadSnapshot(input.threadId);
    return snapshot?.goal ?? normalizeGoalFromResponse(response, input.threadId);
  }

  /** Registers a single completion waiter for a thread until notification, timeout, or disconnect. */
  awaitTurnCompletion(input: {
    threadId: string;
    timeoutMs?: number;
    onStatusMessage?: (message: string) => void;
  }): Promise<TurnOutput> {
    if (this.turnWaiters.has(input.threadId)) {
      throw new Error(`A turn is already in flight for thread ${input.threadId}.`);
    }
    return new Promise<TurnOutput>((resolve, reject) => {
      const timeout = input.timeoutMs
        ? setTimeout(() => {
          this.cancelTurnWait(
            input.threadId,
            new Error(`Timed out waiting for turn completion on thread ${input.threadId} after ${input.timeoutMs}ms.`),
          );
        }, input.timeoutMs)
        : undefined;
      this.turnWaiters.set(input.threadId, {
        finalResponse: "",
        statusMessages: new Set(),
        timeout,
        onStatusMessage: input.onStatusMessage,
        resolve,
        reject,
      });
    });
  }

  /** Rejects and removes the outstanding completion waiter for a thread, if one exists. */
  cancelTurnWait(threadId: string, error = new Error(`Turn wait cancelled for thread ${threadId}.`)): void {
    const waiter = this.turnWaiters.get(threadId);
    if (!waiter) return;
    this.turnWaiters.delete(threadId);
    if (waiter.timeout) clearTimeout(waiter.timeout);
    waiter.reject(error);
  }

  /**
   * Serializes Codex operations that mutate or refresh the shared plugin
   * catalog/cache. Ordinary role-scoped RPCs remain multiplexed.
   */
  withPluginManagerLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withExclusiveOperation("plugin-manager", operation);
  }

  /** Sends a raw JSON-RPC request while retaining response correlation in this client. */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.closing) {
      return Promise.reject(new Error("Codex app-server is closed."));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendMessage({ id, method, params });
    });
  }

  private async withExclusiveOperation<T>(
    key: AppServerExclusiveOperation,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.closing) {
      throw new Error("Codex app-server is closed.");
    }
    const previous = this.exclusiveOperationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.exclusiveOperationTails.set(key, current);
    await previous;
    if (this.closing) {
      release();
      if (this.exclusiveOperationTails.get(key) === current) {
        this.exclusiveOperationTails.delete(key);
      }
      throw new Error("Codex app-server is closed.");
    }
    try {
      return await operation();
    } finally {
      release();
      if (this.exclusiveOperationTails.get(key) === current) {
        this.exclusiveOperationTails.delete(key);
      }
    }
  }

  /** Stops the child process and rejects all operations still waiting on the transport. */
  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.rejectAll(new Error("Codex app-server closed."));
    this.child.stdin.end();
    if (!this.child.killed) {
      this.child.kill();
    }
  }

  /** Installs one dynamic-tool callback and returns a disposer for that callback. */
  setDynamicToolCallHandler(handler: DynamicToolCallHandler): () => void {
    this.onDynamicToolCall = handler;
    return () => {
      if (this.onDynamicToolCall === handler) {
        this.onDynamicToolCall = undefined;
      }
    };
  }

  /** Subscribes to raw protocol messages and returns an unsubscribe function. */
  onMessage(handler: AppServerMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /** Subscribes to protocol notifications and returns an unsubscribe function. */
  onNotification(handler: AppServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  /** Registers a server-request handler and returns an unsubscribe function. */
  onServerRequest(handler: AppServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler);
    return () => {
      this.serverRequestHandlers.delete(handler);
    };
  }

  /** Subscribes to reduced timeline entries and returns an unsubscribe function. */
  onTimeline(handler: AppServerTimelineHandler): () => void {
    this.timelineHandlers.add(handler);
    return () => {
      this.timelineHandlers.delete(handler);
    };
  }

  /** Returns a deep-copied projection suitable for persistence or rendering. */
  getEventStoreSnapshot(): AppServerEventStoreSnapshot {
    return this.eventStore.snapshot();
  }

  /** Returns the latest monotonic sequence number in the event-store timeline. */
  currentTimelineSeq(): number {
    return this.eventStore.currentSeq();
  }

  /** Reads timeline entries after a sequence, optionally scoped by thread or stream. */
  timelineSince(seq: number, filter: {
    threadId?: string;
    stream?: AppServerTimelineStream;
    limit?: number;
  } = {}): AppServerTimelineEntry[] {
    return this.eventStore.timelineSince(seq, filter);
  }

  /** Returns an isolated snapshot of one thread's reduced state. */
  threadSnapshot(threadId: string): AppServerThreadState | undefined {
    return this.eventStore.threadSnapshot(threadId);
  }

  /** Returns an isolated snapshot of one turn within a thread. */
  turnSnapshot(threadId: string, turnId: string): AppServerTurnState | undefined {
    return this.eventStore.turnSnapshot(threadId, turnId);
  }

  /** Looks up one command/tool progress item from the reduced thread state. */
  progressItem(input: {
    threadId: string;
    turnId: string;
    itemId: string;
  }): AppServerProgressItem | undefined {
    return this.eventStore.progressItem(input);
  }

  /** Returns the latest plan projection for a thread. */
  planSnapshot(threadId: string): AppServerPlanState | undefined {
    return this.eventStore.threadSnapshot(threadId)?.plan;
  }

  /** Returns the current goal projection for a thread. */
  goalSnapshot(threadId: string): AppServerThreadGoalState | undefined {
    return this.eventStore.threadSnapshot(threadId)?.goal;
  }

  /** Returns Codex's latest token-usage payload without imposing a provider schema. */
  tokenUsageSnapshot(threadId: string): unknown {
    return this.eventStore.threadSnapshot(threadId)?.tokenUsage;
  }

  /** Joins a timeline entry with the current thread, turn, item, request, and plan projections. */
  resolveTimelineEntry(entry: AppServerTimelineEntry): AppServerResolvedTimelineEntry {
    return this.eventStore.resolveTimelineEntry(entry);
  }

  private notify(method: string, params?: unknown): void {
    this.sendMessage(params === undefined ? { method } : { method, params });
  }

  private startReceiveLoop(): void {
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.receiveLine(line));
  }

  private receiveLine(line: string): void {
    if (!line.trim()) return;

    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      this.writeTransport("incoming_non_json", line);
      this.writeDiagnostic(`non-json: ${line}`);
      return;
    }
    this.writeTransport("incoming", message);

    if (isAppServerMessage(message)) {
      this.emitMessage(message);
      const beforeSeq = this.eventStore.currentSeq();
      this.eventStore.ingestMessage(message);
      this.publishTimelineSince(beforeSeq);
    }

    if (isServerRequest(message)) {
      void this.handleServerRequest(message);
      return;
    }

    if (isResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`Codex app-server ${message.error.code}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (isNotification(message)) {
      this.handleNotification(message);
    }
  }

  private async handleServerRequest(request: JsonRpcServerRequest): Promise<void> {
    const controller: AppServerRequestController = {
      sendResult: (result) => this.sendServerRequestResult(request.id, result),
      sendError: (code, message) => this.sendServerRequestError(request.id, code, message),
    };
    for (const handler of this.serverRequestHandlers) {
      try {
        const handled = await handler(request, controller);
        if (handled) return;
      } catch (error) {
        this.writeDiagnostic(`server request handler failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
    }

    if (request.method === "item/tool/call") {
      void this.handleDynamicToolCallRequest(request);
      return;
    }

    if (request.method === "mcpServer/elicitation/request") {
      this.writeDiagnostic(`auto-accepted app-server request: ${request.method}`);
      this.sendServerRequestResult(request.id, {
        action: "accept",
        content: {},
      });
      return;
    }

    if (process.env.SCOUT_AUTO_ACCEPT_APP_SERVER_CONFIRMATIONS === "1"
      && isAppServerConfirmationRequest(request.method)) {
      this.writeDiagnostic(`auto-accepted app-server request: ${request.method}`);
      this.sendServerRequestResult(request.id, {
        action: "accept",
        content: {},
      });
      return;
    }

    this.writeDiagnostic(`unhandled app-server request: ${request.method}`);
    this.sendServerRequestError(request.id, -32601, `Method not found: ${request.method}`);
  }

  private async handleDynamicToolCallRequest(request: JsonRpcServerRequest): Promise<void> {
    if (!this.onDynamicToolCall) {
      this.sendServerRequestError(request.id, -32601, "No dynamic tool handler registered.");
      return;
    }
    try {
      const params = readObject(request.params);
      const namespace = params.namespace;
      const result = await this.onDynamicToolCall({
        threadId: readString(params, "threadId"),
        turnId: readString(params, "turnId"),
        callId: readString(params, "callId"),
        namespace: typeof namespace === "string" ? namespace : null,
        tool: readString(params, "tool"),
        arguments: params.arguments,
      });
      this.sendServerRequestResult(request.id, result);
    } catch (error) {
      this.sendServerRequestResult(request.id, {
        success: false,
        contentItems: [{
          type: "inputText",
          text: error instanceof Error ? error.stack ?? error.message : String(error),
        }],
      });
    }
  }

  private sendServerRequestResult(id: number | string, result: unknown): void {
    const beforeSeq = this.eventStore.currentSeq();
    this.eventStore.resolveServerRequest({
      id,
      status: "success",
      result,
    });
    this.sendResult(id, result);
    this.publishTimelineSince(beforeSeq);
  }

  private sendServerRequestError(id: number | string, code: number, message: string): void {
    const beforeSeq = this.eventStore.currentSeq();
    this.eventStore.resolveServerRequest({
      id,
      status: "error",
      error: {
        code,
        message,
      },
    });
    this.sendError(id, code, message);
    this.publishTimelineSince(beforeSeq);
  }

  private sendResult(id: number | string, result: unknown): void {
    this.sendMessage({ id, result });
  }

  private sendError(id: number | string, code: number, message: string): void {
    this.sendMessage({ id, error: { code, message } });
  }

  private sendMessage(message: Record<string, unknown>): void {
    this.writeTransport("outgoing", message);
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private writeDiagnostic(message: string): void {
    const normalized = message.endsWith("\n") ? message : `${message}\n`;
    const rendered = `[${this.logPrefix}] ${normalized}`;
    if (this.writeDiagnosticsToStderr) process.stderr.write(rendered);
    if (!this.stderrLogPath) return;
    appendFileSync(
      this.stderrLogPath,
      `${new Date().toISOString()} ${rendered}`,
      "utf8",
    );
  }

  private writeTransport(direction: string, payload: unknown): void {
    if (!this.transportLogPath) return;
    appendFileSync(this.transportLogPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      direction,
      payload,
    }) + "\n", "utf8");
  }

  private emitMessage(message: JsonRpcMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        this.writeDiagnostic(`message handler failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
    }
  }

  private publishTimelineSince(seq: number): void {
    for (const entry of this.eventStore.timelineSince(seq)) {
      for (const handler of this.timelineHandlers) {
        try {
          handler(entry);
        } catch (error) {
          this.writeDiagnostic(`timeline handler failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        }
      }
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    for (const handler of this.notificationHandlers) {
      try {
        handler(notification);
      } catch (error) {
        this.writeDiagnostic(`notification handler failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
    }

    if (notification.method === "turn/completed") {
      const params = readObject(notification.params);
      const threadId = readString(params, "threadId");
      const turnId = readOptionalTurnId(params);
      const waiter = this.turnWaiters.get(threadId);
      if (!waiter) return;
      this.turnWaiters.delete(threadId);
      if (waiter.timeout) clearTimeout(waiter.timeout);
      waiter.resolve({
        turnId,
        finalResponse: resolveFinalResponse({
          fallback: waiter.finalResponse,
          store: this.eventStore,
          threadId,
          turnId,
        }),
        response: notification.params,
        eventStoreSnapshot: this.eventStore.snapshot(),
        turnSnapshot: turnSnapshot({
          store: this.eventStore,
          threadId,
          turnId,
        }),
        progressItems: this.eventStore.progressItems({
          threadId,
          turnId,
        }),
        plan: this.eventStore.threadSnapshot(threadId)?.plan,
        goal: this.eventStore.threadSnapshot(threadId)?.goal,
      });
      return;
    }

    if (notification.method === "item/completed") {
      const params = readObject(notification.params);
      const threadId = readString(params, "threadId");
      const waiter = this.turnWaiters.get(threadId);
      if (!waiter) return;

      const item = readObject(params.item);
      if (item.type !== "agentMessage") return;
      const text = readString(item, "text");
      waiter.finalResponse = text;
      if (text.trim().length > 0 && !waiter.statusMessages.has(text)) {
        waiter.statusMessages.add(text);
        waiter.onStatusMessage?.(text);
      }
      return;
    }

    if (notification.method === "item/started") {
      const params = readObject(notification.params);
      const threadId = readString(params, "threadId");
      const waiter = this.turnWaiters.get(threadId);
      if (!waiter) return;
      return;
    }

    if (notification.method === "item/agentMessage/delta") {
      const params = readObject(notification.params);
      const threadId = readString(params, "threadId");
      const waiter = this.turnWaiters.get(threadId);
      if (!waiter) return;
      waiter.finalResponse += readString(params, "delta");
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();

    for (const waiter of this.turnWaiters.values()) {
      if (waiter.timeout) clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.turnWaiters.clear();

  }

  private handleDisconnect(message: string): void {
    const beforeSeq = this.eventStore.currentSeq();
    this.eventStore.markDisconnected(message);
    this.publishTimelineSince(beforeSeq);
  }
}

/** Reads a required string at a nested object path and rejects malformed protocol data. */
export function readNestedString(value: unknown, path: string[]): string {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      throw new Error(`Expected object while reading ${path.join(".")}.`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current !== "string") {
    throw new Error(`Expected string at ${path.join(".")}.`);
  }
  return current;
}

function readTurnId(value: unknown): string {
  try {
    return readNestedString(value, ["turn", "id"]);
  } catch {
    return readNestedString(value, ["turnId"]);
  }
}

function readOptionalTurnId(params: Record<string, unknown>): string | undefined {
  const direct = readOptionalString(params, "turnId");
  if (direct) return direct;
  const turn = params.turn;
  if (typeof turn === "object" && turn !== null && !Array.isArray(turn)) {
    return readOptionalString(turn as Record<string, unknown>, "id");
  }
  return undefined;
}

function normalizeGoalFromResponse(value: unknown, fallbackThreadId: string): AppServerThreadGoalState | undefined {
  const root = readObject(value);
  const goal = readObject(root.goal);
  const objective = readString(goal, "objective");
  if (!objective) return undefined;
  return {
    threadId: readString(goal, "threadId") ?? fallbackThreadId,
    objective,
    status: readString(goal, "status") ?? "active",
    tokenBudget: readNumber(goal, "tokenBudget"),
    tokensUsed: readNumber(goal, "tokensUsed"),
    timeUsedSeconds: readNumber(goal, "timeUsedSeconds"),
    createdAt: readNumber(goal, "createdAt"),
    updatedAt: readNumber(goal, "updatedAt"),
    raw: goal,
  };
}

function resolveFinalResponse(input: {
  store: AppServerEventStore;
  threadId: string;
  turnId?: string;
  fallback: string;
}): string {
  if (!input.turnId) return input.fallback;
  return input.store.finalResponse(input.threadId, input.turnId) || input.fallback;
}

function turnSnapshot(input: {
  store: AppServerEventStore;
  threadId: string;
  turnId?: string;
}): AppServerTurnState | undefined {
  if (!input.turnId) return undefined;
  return input.store.turnSnapshot(input.threadId, input.turnId);
}

function isResponse(value: unknown): value is JsonRpcResponse {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).id === "number";
}

function isServerRequest(value: unknown): value is JsonRpcServerRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const object = value as Record<string, unknown>;
  return (typeof object.id === "number" || typeof object.id === "string")
    && typeof object.method === "string";
}

function isNotification(value: unknown): value is JsonRpcNotification {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).method === "string";
}

function isAppServerMessage(value: unknown): value is JsonRpcMessage {
  return isServerRequest(value) || isResponse(value) || isNotification(value);
}

function isAppServerConfirmationRequest(method: string): boolean {
  const normalized = method.toLowerCase();
  return [
    "elicitation",
    "approval",
    "confirm",
    "confirmation",
    "permission",
    "consent",
    "authorize",
    "authorization",
  ].some((token) => normalized.includes(token))
    || normalized.endsWith("/prompt/request")
    || normalized.endsWith("/input/request");
}

function assertActivePermissionProfile(
  value: unknown,
  expectedId: string,
  context: string,
): void {
  const response = readObject(value);
  const profile = readObject(response.activePermissionProfile);
  const actualId = readString(profile, "id");
  if (actualId !== expectedId) {
    throw new Error(
      `Codex ${context} with permission profile ${actualId}, expected ${expectedId}.`,
    );
  }
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object.");
  }
  return value as Record<string, unknown>;
}

function readString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new Error(`Expected string at ${key}.`);
  }
  return value;
}

function readOptionalString(object: Record<string, unknown>, key: string): string | undefined {
  return typeof object[key] === "string" ? object[key] : undefined;
}

function readNumber(object: Record<string, unknown>, key: string): number | undefined {
  return typeof object[key] === "number" ? object[key] : undefined;
}

function cleanUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function readProviderConfig(providerName: string): { baseUrl?: string; envKey?: string; codexCliPath?: string } {
  try {
    const text = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
    const providerBlock = matchTomlBlock(text, `model_providers.${providerName}`);
    return {
      baseUrl: readTomlString(providerBlock, "base_url"),
      envKey: readTomlString(providerBlock, "env_key"),
      codexCliPath: readTomlString(text, "CODEX_CLI_PATH"),
    };
  } catch {
    return {};
  }
}

function matchTomlBlock(text: string, blockName: string): string {
  const escaped = blockName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = text.match(new RegExp(`^\\[${escaped}\\]\\r?\\n`, "m"));
  if (!header || header.index === undefined) return "";
  const contentStart = header.index + header[0].length;
  const rest = text.slice(contentStart);
  const nextHeader = rest.search(/\r?\n\[/);
  return nextHeader === -1 ? rest : rest.slice(0, nextHeader);
}

function readTomlString(text: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`^${escaped}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
}
