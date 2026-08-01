import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

export interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

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

export interface TurnStartResponse {
  turnId: string;
  response: unknown;
}

export interface CodexAppServerOptions {
  codexPath?: string;
  home: string;
  codexHome: string;
  providerName?: string;
  logPrefix?: string;
  stderrLogPath?: string;
  transportLogPath?: string;
  onDynamicToolCall?: DynamicToolCallHandler;
}

export interface ThreadStartOptions {
  cwd: string;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: CodexReasoningEffort;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  ephemeral?: boolean;
  config?: Record<string, unknown>;
  baseInstructions?: string;
  developerInstructions?: string;
  dynamicTools?: DynamicToolSpec[];
}

export interface ThreadStartRequest {
  cwd: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  ephemeral: boolean;
  config?: Record<string, unknown>;
  baseInstructions?: string;
  developerInstructions?: string;
  dynamicTools?: DynamicToolSpec[];
}

export interface ThreadStartResponse {
  threadId: string;
  startInput: ThreadStartRequest;
  response: unknown;
}

export interface ThreadResumeOptions {
  threadId: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: CodexReasoningEffort;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  config?: Record<string, unknown>;
  baseInstructions?: string;
  developerInstructions?: string;
}

export interface ThreadResumeRequest {
  threadId: string;
  excludeTurns: true;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  config?: Record<string, unknown>;
  baseInstructions?: string;
  developerInstructions?: string;
}

export interface ThreadResumeResponse {
  threadId: string;
  resumeInput: ThreadResumeRequest;
  response: unknown;
}

export interface TurnStartOptions {
  threadId: string;
  prompt: string;
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  reasoningSummary?: CodexReasoningSummary;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  sandbox?: "readOnly" | "workspaceWrite";
  writableRoots?: string[];
  onStatusMessage?: (message: string) => void;
  onTurnStarted?: (turnId: string) => void;
}

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

export interface DynamicToolSpec {
  namespace?: string;
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
}

export interface DynamicToolCallInput {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

export type DynamicToolCallHandler = (
  input: DynamicToolCallInput,
) => Promise<DynamicToolCallResponse> | DynamicToolCallResponse;

export type AppServerNotificationHandler = (
  notification: JsonRpcNotification,
) => void;

export interface AppServerRequestController {
  sendResult(result: unknown): void;
  sendError(code: number, message: string): void;
}

export type AppServerRequestHandler = (
  request: JsonRpcServerRequest,
  controller: AppServerRequestController,
) => boolean | Promise<boolean>;

export type AppServerMessageHandler = (message: JsonRpcMessage) => void;
export type AppServerTimelineHandler = (entry: AppServerTimelineEntry) => void;

export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly messageHandlers = new Set<AppServerMessageHandler>();
  private readonly notificationHandlers = new Set<AppServerNotificationHandler>();
  private readonly serverRequestHandlers = new Set<AppServerRequestHandler>();
  private readonly timelineHandlers = new Set<AppServerTimelineHandler>();
  private readonly eventStore = new AppServerEventStore();
  private readonly logPrefix: string;
  private readonly stderrLogPath?: string;
  private readonly transportLogPath?: string;
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
    if (provider.envKey && process.env[provider.envKey]) {
      env.CODEX_API_KEY = process.env[provider.envKey];
    }
    if (provider.baseUrl) {
      env.OPENAI_BASE_URL = provider.baseUrl;
    }

    this.logPrefix = options.logPrefix ?? "scout app-server";
    this.stderrLogPath = options.stderrLogPath;
    this.transportLogPath = options.transportLogPath;
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

  async startThread(options: ThreadStartOptions): Promise<ThreadStartResponse> {
    const startInput: ThreadStartRequest = cleanUndefined({
      model: options.model,
      modelProvider: options.modelProvider,
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy ?? "never",
      sandbox: options.sandbox ?? "workspace-write",
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
    return {
      threadId: readNestedString(response, ["thread", "id"]),
      startInput,
      response,
    };
  }

  async resumeThread(options: ThreadResumeOptions): Promise<ThreadResumeResponse> {
    const resumeInput: ThreadResumeRequest = cleanUndefined({
      threadId: options.threadId,
      excludeTurns: true as const,
      model: options.model,
      modelProvider: options.modelProvider,
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy,
      sandbox: options.sandbox,
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
    const threadId = readNestedString(response, ["thread", "id"]);
    if (threadId !== options.threadId) {
      throw new Error(
        `Codex resumed thread ${threadId}, expected ${options.threadId}.`,
      );
    }
    return {
      threadId,
      resumeInput,
      response,
    };
  }

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

  async startTurn(options: TurnStartOptions): Promise<TurnStartResponse> {
    const response = await this.request("turn/start", cleanUndefined({
      threadId: options.threadId,
      input: [{ type: "text", text: options.prompt, text_elements: [] }],
      approvalPolicy: options.approvalPolicy ?? "never",
      sandboxPolicy: buildSandboxPolicy({
        type: options.sandbox ?? "workspaceWrite",
        writableRoots: options.writableRoots,
      }),
      model: options.model,
      effort: options.reasoningEffort,
      summary: options.reasoningSummary,
    }));
    return {
      turnId: readTurnId(response),
      response,
    };
  }

  async interruptTurn(input: {
    threadId: string;
    turnId: string;
  }): Promise<unknown> {
    return this.request("turn/interrupt", {
      threadId: input.threadId,
      turnId: input.turnId,
    });
  }

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

  cancelTurnWait(threadId: string, error = new Error(`Turn wait cancelled for thread ${threadId}.`)): void {
    const waiter = this.turnWaiters.get(threadId);
    if (!waiter) return;
    this.turnWaiters.delete(threadId);
    if (waiter.timeout) clearTimeout(waiter.timeout);
    waiter.reject(error);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendMessage({ id, method, params });
    });
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.rejectAll(new Error("Codex app-server closed."));
    this.child.stdin.end();
    if (!this.child.killed) {
      this.child.kill();
    }
  }

  setDynamicToolCallHandler(handler: DynamicToolCallHandler): () => void {
    this.onDynamicToolCall = handler;
    return () => {
      if (this.onDynamicToolCall === handler) {
        this.onDynamicToolCall = undefined;
      }
    };
  }

  onMessage(handler: AppServerMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onNotification(handler: AppServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  onServerRequest(handler: AppServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler);
    return () => {
      this.serverRequestHandlers.delete(handler);
    };
  }

  onTimeline(handler: AppServerTimelineHandler): () => void {
    this.timelineHandlers.add(handler);
    return () => {
      this.timelineHandlers.delete(handler);
    };
  }

  getEventStoreSnapshot(): AppServerEventStoreSnapshot {
    return this.eventStore.snapshot();
  }

  currentTimelineSeq(): number {
    return this.eventStore.currentSeq();
  }

  timelineSince(seq: number, filter: {
    threadId?: string;
    stream?: AppServerTimelineStream;
    limit?: number;
  } = {}): AppServerTimelineEntry[] {
    return this.eventStore.timelineSince(seq, filter);
  }

  threadSnapshot(threadId: string): AppServerThreadState | undefined {
    return this.eventStore.threadSnapshot(threadId);
  }

  turnSnapshot(threadId: string, turnId: string): AppServerTurnState | undefined {
    return this.eventStore.turnSnapshot(threadId, turnId);
  }

  progressItem(input: {
    threadId: string;
    turnId: string;
    itemId: string;
  }): AppServerProgressItem | undefined {
    return this.eventStore.progressItem(input);
  }

  planSnapshot(threadId: string): AppServerPlanState | undefined {
    return this.eventStore.threadSnapshot(threadId)?.plan;
  }

  goalSnapshot(threadId: string): AppServerThreadGoalState | undefined {
    return this.eventStore.threadSnapshot(threadId)?.goal;
  }

  tokenUsageSnapshot(threadId: string): unknown {
    return this.eventStore.threadSnapshot(threadId)?.tokenUsage;
  }

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
    process.stderr.write(rendered);
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

function buildSandboxPolicy(input: {
  type: "readOnly" | "workspaceWrite";
  writableRoots?: string[];
}): Record<string, unknown> {
  if (input.type === "readOnly") {
    return {
      type: "readOnly",
      networkAccess: false,
    };
  }
  return {
    type: "workspaceWrite",
    writableRoots: [...new Set(input.writableRoots ?? [])],
    networkAccess: false,
  };
}

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
