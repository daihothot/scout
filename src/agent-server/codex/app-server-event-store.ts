import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcServerRequest,
} from "./app-server-client.js";

export type AppServerItemStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped"
  | "pending"
  | string;

export interface AppServerBaseItem {
  id: string;
  type: string;
  status?: AppServerItemStatus;
}

export interface AppServerAgentMessageItem extends AppServerBaseItem {
  type: "agentMessage";
  text: string;
  phase?: string | null;
}

export interface AppServerPlanItem extends AppServerBaseItem {
  type: "plan";
  text: string;
}

export interface AppServerReasoningItem extends AppServerBaseItem {
  type: "reasoning";
  summary?: string[];
  content?: string[];
}

export interface AppServerCommandExecutionItem extends AppServerBaseItem {
  type: "commandExecution";
  command: string;
  cwd?: string;
  status: AppServerItemStatus;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number | null;
}

export interface AppServerDynamicToolCallItem extends AppServerBaseItem {
  type: "dynamicToolCall";
  tool: string;
  arguments?: unknown;
  status: AppServerItemStatus;
  contentItems?: unknown[] | null;
  success?: boolean | null;
  durationMs?: number | null;
}

export interface AppServerMcpToolCallItem extends AppServerBaseItem {
  type: "mcpToolCall";
  server: string;
  tool: string;
  arguments?: unknown;
  status: AppServerItemStatus;
  result?: unknown;
  error?: unknown;
  durationMs?: number | null;
}

export interface AppServerFileChangeItem extends AppServerBaseItem {
  type: "fileChange";
  changes?: unknown[];
  status?: AppServerItemStatus;
}

export interface AppServerUnknownItem extends AppServerBaseItem {
  type: "unknown";
  rawType: string;
  raw: Record<string, unknown>;
}

export type AppServerItem =
  | AppServerAgentMessageItem
  | AppServerPlanItem
  | AppServerReasoningItem
  | AppServerCommandExecutionItem
  | AppServerDynamicToolCallItem
  | AppServerMcpToolCallItem
  | AppServerFileChangeItem
  | AppServerUnknownItem;

export type AppServerProgressSourceItem =
  | AppServerCommandExecutionItem
  | AppServerDynamicToolCallItem
  | AppServerMcpToolCallItem;

export interface AppServerPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed" | string;
  raw: Record<string, unknown>;
}

export interface AppServerThreadGoalState {
  threadId: string;
  objective: string;
  status: string;
  tokenBudget?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  createdAt?: number;
  updatedAt?: number;
  raw: Record<string, unknown>;
}

export interface AppServerProgressItem {
  itemId: string;
  threadId: string;
  turnId: string;
  type: "commandExecution" | "dynamicToolCall" | "mcpToolCall";
  status: string;
  label: string;
  detail?: string;
  item: AppServerProgressSourceItem;
  updatedAt: string;
}

export interface AppServerTurnState {
  id: string;
  threadId: string;
  status?: string;
  error?: unknown;
  items: Record<string, AppServerItem>;
  itemOrder: string[];
  finalResponse: string;
  completedAt?: string;
  updatedAt: string;
}

export interface AppServerPlanState {
  turnId?: string;
  explanation: string;
  steps: AppServerPlanStep[];
  streaming: string;
  updatedAt?: string;
}

export interface AppServerThreadState {
  id: string;
  meta?: Record<string, unknown>;
  tokenUsage?: unknown;
  goal?: AppServerThreadGoalState;
  plan: AppServerPlanState;
  turns: Record<string, AppServerTurnState>;
  turnOrder: string[];
  latestTurnId?: string;
  updatedAt: string;
}

export interface AppServerPendingRequestState {
  id: string;
  method: string;
  params?: unknown;
  receivedAt: string;
  resolvedAt?: string;
  resolution?: AppServerRequestResolutionState;
}

export interface AppServerRequestResolutionState {
  status: "success" | "error";
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export const AppServerTimelineStreams = {
  Lifecycle: "lifecycle",
  State: "state",
  Plan: "plan",
  Item: "item",
  Request: "request",
} as const;
export type AppServerTimelineStream = typeof AppServerTimelineStreams[keyof typeof AppServerTimelineStreams];

export interface AppServerTimelineEntry {
  seq: number;
  receivedAt: string;
  stream: AppServerTimelineStream;
  kind: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  requestId?: string;
}

export interface AppServerEventStoreSnapshot {
  threads: Record<string, AppServerThreadState>;
  threadOrder: string[];
  pendingRequests: Record<string, AppServerPendingRequestState>;
  progressItems: AppServerProgressItem[];
  timeline: AppServerTimelineEntry[];
  currentSeq: number;
  droppedTimelineCount: number;
}

export interface AppServerResolvedTimelineEntry {
  entry: AppServerTimelineEntry;
  thread?: AppServerThreadState;
  turn?: AppServerTurnState;
  item?: AppServerItem;
  progressItem?: AppServerProgressItem;
  request?: AppServerPendingRequestState;
  pendingRequest?: AppServerPendingRequestState;
  plan?: AppServerPlanState;
  goal?: AppServerThreadGoalState;
  tokenUsage?: unknown;
}

export class AppServerEventStore {
  private readonly threads = new Map<string, AppServerThreadState>();
  private readonly threadOrder: string[] = [];
  private readonly requests = new Map<string, AppServerPendingRequestState>();
  private readonly pendingRequests = new Map<string, AppServerPendingRequestState>();
  private readonly timeline: AppServerTimelineEntry[] = [];
  private readonly timelineLimit: number;
  private timelineSeq = 0;
  private droppedTimelineCount = 0;

  constructor(options: { timelineLimit?: number } = {}) {
    this.timelineLimit = options.timelineLimit ?? 1000;
  }

  ingestMessage(message: JsonRpcMessage): void {
    if (isServerRequest(message)) {
      this.ingestServerRequest(message);
      return;
    }
    if (isResponse(message)) {
      this.ingestResponse(message);
      return;
    }
    this.ingestNotification(message);
  }

  ingestNotification(notification: JsonRpcNotification): void {
    const receivedAt = nowIso();
    this.applyNotification(notification);
    this.appendNotificationTimeline(notification, receivedAt);
  }

  ingestServerRequest(request: JsonRpcServerRequest): void {
    const receivedAt = nowIso();
    const requestState = {
      id: String(request.id),
      method: request.method,
      params: request.params,
      receivedAt,
    };
    this.requests.set(String(request.id), requestState);
    this.pendingRequests.set(String(request.id), requestState);
    const params = readObjectOrUndefined(request.params);
    this.appendTimeline({
      stream: AppServerTimelineStreams.Request,
      kind: "server_request",
      receivedAt,
      threadId: readString(params, "threadId"),
      turnId: readString(params, "turnId"),
      requestId: String(request.id),
    });
  }

  ingestResponse(response: JsonRpcResponse): void {
    this.appendTimeline({
      stream: AppServerTimelineStreams.Lifecycle,
      kind: "response",
      receivedAt: nowIso(),
      requestId: String(response.id),
    });
  }

  resolveServerRequest(input: {
    id: string | number;
    status: AppServerRequestResolutionState["status"];
    result?: unknown;
    error?: AppServerRequestResolutionState["error"];
  }): void {
    const requestId = String(input.id);
    const receivedAt = nowIso();
    const request = this.requests.get(requestId) ?? this.pendingRequests.get(requestId);
    if (request) {
      request.resolvedAt = receivedAt;
      request.resolution = cloneJson({
        status: input.status,
        result: input.result,
        error: input.error,
      });
    }
    const params = readObjectOrUndefined(request?.params);
    this.appendTimeline({
      stream: AppServerTimelineStreams.Request,
      kind: "server_request_resolved",
      receivedAt,
      threadId: readString(params, "threadId"),
      turnId: readString(params, "turnId"),
      requestId,
    });
    if (request) this.requests.set(requestId, request);
    this.pendingRequests.delete(requestId);
  }

  markDisconnected(message: string): void {
    this.appendTimeline({
      stream: AppServerTimelineStreams.Lifecycle,
      kind: "disconnect",
      receivedAt: nowIso(),
    });
  }

  snapshot(): AppServerEventStoreSnapshot {
    const threads = Object.fromEntries(
      [...this.threads.entries()].map(([id, state]) => [id, cloneJson(state)]),
    );
    const pendingRequests = Object.fromEntries(
      [...this.pendingRequests.entries()].map(([id, state]) => [id, { ...state }]),
    );
    return {
      threads,
      threadOrder: [...this.threadOrder],
      pendingRequests,
      progressItems: this.progressItems().map((item) => cloneJson(item)),
      timeline: this.timeline.map((entry) => ({ ...entry })),
      currentSeq: this.timelineSeq,
      droppedTimelineCount: this.droppedTimelineCount,
    };
  }

  currentSeq(): number {
    return this.timelineSeq;
  }

  timelineSince(seq: number, filter: {
    threadId?: string;
    stream?: AppServerTimelineStream;
    limit?: number;
  } = {}): AppServerTimelineEntry[] {
    const entries: AppServerTimelineEntry[] = [];
    for (const entry of this.timeline) {
      if (entry.seq <= seq) continue;
      if (filter.threadId && entry.threadId !== filter.threadId) continue;
      if (filter.stream && entry.stream !== filter.stream) continue;
      entries.push({ ...entry });
      if (filter.limit && entries.length >= filter.limit) break;
    }
    return entries;
  }

  resolveTimelineEntry(entry: AppServerTimelineEntry): AppServerResolvedTimelineEntry {
    const thread = entry.threadId ? this.threadSnapshot(entry.threadId) : undefined;
    const turn = entry.threadId && entry.turnId ? this.turnSnapshot(entry.threadId, entry.turnId) : undefined;
    const item = entry.threadId && entry.turnId && entry.itemId
      ? this.itemSnapshot({
        threadId: entry.threadId,
        turnId: entry.turnId,
        itemId: entry.itemId,
      })
      : undefined;
    const progressItem = entry.threadId && entry.turnId && entry.itemId
      ? this.progressItem({
        threadId: entry.threadId,
        turnId: entry.turnId,
        itemId: entry.itemId,
      })
      : undefined;
    const request = entry.requestId ? this.requestSnapshot(entry.requestId) : undefined;
    const pendingRequest = entry.requestId ? this.pendingRequestSnapshot(entry.requestId) : undefined;
    return {
      entry: { ...entry },
      thread,
      turn,
      item,
      progressItem,
      request,
      pendingRequest,
      plan: thread?.plan,
      goal: thread?.goal,
      tokenUsage: thread?.tokenUsage,
    };
  }

  threadSnapshot(threadId: string): AppServerThreadState | undefined {
    const thread = this.threads.get(threadId);
    return thread ? cloneJson(thread) : undefined;
  }

  turnSnapshot(threadId: string, turnId: string): AppServerTurnState | undefined {
    const turn = this.threads.get(threadId)?.turns[turnId];
    return turn ? cloneJson(turn) : undefined;
  }

  itemSnapshot(input: {
    threadId: string;
    turnId: string;
    itemId: string;
  }): AppServerItem | undefined {
    const item = this.threads.get(input.threadId)?.turns[input.turnId]?.items[input.itemId];
    return item ? cloneJson(item) : undefined;
  }

  pendingRequestSnapshot(requestId: string): AppServerPendingRequestState | undefined {
    const request = this.pendingRequests.get(requestId);
    return request ? cloneJson(request) : undefined;
  }

  requestSnapshot(requestId: string): AppServerPendingRequestState | undefined {
    const request = this.requests.get(requestId);
    return request ? cloneJson(request) : undefined;
  }

  progressItems(input: {
    threadId?: string;
    turnId?: string;
    activeOnly?: boolean;
  } = {}): AppServerProgressItem[] {
    const items: AppServerProgressItem[] = [];
    for (const thread of this.threads.values()) {
      if (input.threadId && thread.id !== input.threadId) continue;
      for (const turn of Object.values(thread.turns)) {
        if (input.turnId && turn.id !== input.turnId) continue;
        for (const itemId of turn.itemOrder) {
          const item = turn.items[itemId];
          const progress = toProgressItem({
            threadId: thread.id,
            turnId: turn.id,
            item,
            updatedAt: turn.updatedAt,
          });
          if (!progress) continue;
          if (input.activeOnly && progress.status !== "inProgress") continue;
          items.push(progress);
        }
      }
    }
    return items;
  }

  progressItem(input: {
    threadId: string;
    turnId: string;
    itemId: string;
  }): AppServerProgressItem | undefined {
    const turn = this.threads.get(input.threadId)?.turns[input.turnId];
    const item = turn?.items[input.itemId];
    if (!turn || !item) return undefined;
    return toProgressItem({
      threadId: input.threadId,
      turnId: input.turnId,
      item,
      updatedAt: turn.updatedAt,
    });
  }

  finalResponse(threadId: string, turnId: string): string {
    return this.threads.get(threadId)?.turns[turnId]?.finalResponse ?? "";
  }

  private applyNotification(notification: JsonRpcNotification): void {
    const params = readObjectOrUndefined(notification.params);
    if (!params) return;

    switch (notification.method) {
      case "thread/started": {
        const thread = readObjectOrUndefined(params.thread);
        const threadId = readString(thread, "id");
        if (!threadId) return;
        const state = this.ensureThread(threadId);
        state.meta = cloneJson(thread ?? {});
        state.updatedAt = nowIso();
        this.moveThreadToFront(threadId);
        return;
      }
      case "thread/status/changed": {
        const threadId = readString(params, "threadId");
        if (!threadId) return;
        const state = this.ensureThread(threadId);
        state.meta = {
          ...(state.meta ?? {}),
          status: params.status,
        };
        state.updatedAt = nowIso();
        this.moveThreadToFront(threadId);
        return;
      }
      case "thread/name/updated": {
        const threadId = readString(params, "threadId");
        if (!threadId) return;
        const state = this.ensureThread(threadId);
        state.meta = {
          ...(state.meta ?? {}),
          name: params.threadName,
        };
        state.updatedAt = nowIso();
        return;
      }
      case "thread/tokenUsage/updated": {
        const threadId = readString(params, "threadId");
        if (!threadId) return;
        const state = this.ensureThread(threadId);
        state.tokenUsage = params.tokenUsage;
        state.latestTurnId = readString(params, "turnId") ?? state.latestTurnId;
        state.updatedAt = nowIso();
        return;
      }
      case "thread/goal/updated": {
        const threadId = readString(params, "threadId");
        const goal = normalizeGoal(params.goal, threadId);
        const resolvedThreadId = goal?.threadId ?? threadId;
        if (!resolvedThreadId || !goal) return;
        const state = this.ensureThread(resolvedThreadId);
        state.goal = goal;
        state.updatedAt = nowIso();
        this.moveThreadToFront(resolvedThreadId);
        return;
      }
      case "thread/goal/cleared": {
        const threadId = readString(params, "threadId");
        if (!threadId) return;
        const state = this.ensureThread(threadId);
        state.goal = undefined;
        state.updatedAt = nowIso();
        this.moveThreadToFront(threadId);
        return;
      }
      case "turn/started": {
        const threadId = readString(params, "threadId");
        const turn = readObjectOrUndefined(params.turn);
        const turnId = readString(turn, "id");
        if (!threadId || !turnId) return;
        const state = this.ensureTurn(threadId, turnId);
        state.status = readString(turn, "status") ?? state.status;
        state.error = turn?.error;
        state.updatedAt = nowIso();
        this.ensureThread(threadId).latestTurnId = turnId;
        this.moveThreadToFront(threadId);
        return;
      }
      case "turn/completed": {
        const threadId = readString(params, "threadId");
        const turn = readObjectOrUndefined(params.turn);
        const turnId = readString(turn, "id") ?? readString(params, "turnId");
        if (!threadId || !turnId) return;
        const state = this.ensureTurn(threadId, turnId);
        state.status = readString(turn, "status") ?? "completed";
        state.error = turn?.error;
        state.completedAt = nowIso();
        state.updatedAt = nowIso();
        this.ensureThread(threadId).latestTurnId = turnId;
        this.moveThreadToFront(threadId);
        return;
      }
      case "turn/plan/updated": {
        const threadId = readString(params, "threadId");
        if (!threadId) return;
        const thread = this.ensureThread(threadId);
        thread.plan = {
          turnId: readString(params, "turnId"),
          explanation: readString(params, "explanation") ?? "",
          steps: readArray(params.plan).map(normalizePlanStep).filter(isDefined),
          streaming: "",
          updatedAt: nowIso(),
        };
        thread.latestTurnId = thread.plan.turnId ?? thread.latestTurnId;
        thread.updatedAt = nowIso();
        this.moveThreadToFront(threadId);
        return;
      }
      case "item/plan/delta": {
        const threadId = readString(params, "threadId");
        if (!threadId) return;
        const thread = this.ensureThread(threadId);
        thread.plan.turnId = readString(params, "turnId") ?? thread.plan.turnId;
        thread.plan.streaming += readString(params, "delta") ?? "";
        thread.plan.updatedAt = nowIso();
        thread.latestTurnId = thread.plan.turnId ?? thread.latestTurnId;
        thread.updatedAt = nowIso();
        this.moveThreadToFront(threadId);
        return;
      }
      case "item/started":
      case "item/completed": {
        const threadId = readString(params, "threadId");
        const turnId = readString(params, "turnId");
        const item = normalizeItem(params.item);
        const itemId = item?.id;
        if (!threadId || !turnId || !item || !itemId) return;
        const turn = this.ensureTurn(threadId, turnId);
        turn.items[itemId] = cloneJson(item);
        if (!turn.itemOrder.includes(itemId)) {
          turn.itemOrder.push(itemId);
        }
        if (item.type === "agentMessage" && item.text.trim()) {
          turn.finalResponse = item.text;
        }
        turn.updatedAt = nowIso();
        const thread = this.ensureThread(threadId);
        thread.latestTurnId = turnId;
        thread.updatedAt = nowIso();
        this.moveThreadToFront(threadId);
        return;
      }
      case "item/agentMessage/delta": {
        const threadId = readString(params, "threadId");
        const turnId = readString(params, "turnId");
        if (!threadId || !turnId) return;
        const turn = this.ensureTurn(threadId, turnId);
        turn.finalResponse += readString(params, "delta") ?? "";
        turn.updatedAt = nowIso();
        return;
      }
      case "serverRequest/resolved": {
        const requestId = readString(params, "requestId") ?? readNumber(params, "requestId")?.toString();
        if (requestId) this.pendingRequests.delete(requestId);
        return;
      }
      default:
        return;
    }
  }

  private ensureThread(threadId: string): AppServerThreadState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = {
        id: threadId,
        plan: {
          explanation: "",
          steps: [],
          streaming: "",
        },
        turns: {},
        turnOrder: [],
        updatedAt: nowIso(),
      };
      this.threads.set(threadId, state);
      this.threadOrder.unshift(threadId);
    }
    return state;
  }

  private ensureTurn(threadId: string, turnId: string): AppServerTurnState {
    const thread = this.ensureThread(threadId);
    let turn = thread.turns[turnId];
    if (!turn) {
      turn = {
        id: turnId,
        threadId,
        items: {},
        itemOrder: [],
        finalResponse: "",
        updatedAt: nowIso(),
      };
      thread.turns[turnId] = turn;
      thread.turnOrder.push(turnId);
    }
    return turn;
  }

  private moveThreadToFront(threadId: string): void {
    const index = this.threadOrder.indexOf(threadId);
    if (index === -1) {
      this.threadOrder.unshift(threadId);
      return;
    }
    if (index === 0) return;
    this.threadOrder.splice(index, 1);
    this.threadOrder.unshift(threadId);
  }

  private appendNotificationTimeline(notification: JsonRpcNotification, receivedAt: string): void {
    const entry = timelineEntryFromNotification(notification, receivedAt);
    if (entry) this.appendTimeline(entry);
  }

  private appendTimeline(entry: Omit<AppServerTimelineEntry, "seq">): void {
    this.timelineSeq += 1;
    this.timeline.push({
      seq: this.timelineSeq,
      ...entry,
    });
    while (this.timeline.length > this.timelineLimit) {
      this.timeline.shift();
      this.droppedTimelineCount += 1;
    }
  }
}

function timelineEntryFromNotification(
  notification: JsonRpcNotification,
  receivedAt: string,
): Omit<AppServerTimelineEntry, "seq"> | undefined {
  const params = readObjectOrUndefined(notification.params);
  if (!params) return undefined;

  switch (notification.method) {
    case "thread/started": {
      const thread = readObjectOrUndefined(params.thread);
      const threadId = readString(thread, "id");
      return threadId ? {
        stream: AppServerTimelineStreams.Lifecycle,
        kind: "thread_started",
        receivedAt,
        threadId,
      } : undefined;
    }
    case "thread/status/changed":
      return appServerTimelineEntry({
        stream: AppServerTimelineStreams.Lifecycle,
        kind: "thread_status_changed",
        receivedAt,
        params,
      });
    case "thread/name/updated":
      return appServerTimelineEntry({
        stream: AppServerTimelineStreams.Lifecycle,
        kind: "thread_name_updated",
        receivedAt,
        params,
      });
    case "turn/started": {
      const turn = readObjectOrUndefined(params.turn);
      return appServerTimelineEntry({
        stream: AppServerTimelineStreams.Lifecycle,
        kind: "turn_started",
        receivedAt,
        params,
        turnId: readString(turn, "id"),
      });
    }
    case "turn/completed": {
      const turn = readObjectOrUndefined(params.turn);
      return appServerTimelineEntry({
        stream: AppServerTimelineStreams.Lifecycle,
        kind: "turn_completed",
        receivedAt,
        params,
        turnId: readString(params, "turnId") ?? readString(turn, "id"),
      });
    }
    case "thread/tokenUsage/updated":
      return appServerTimelineEntry({
        stream: AppServerTimelineStreams.State,
        kind: "token_usage_updated",
        receivedAt,
        params,
        turnId: readString(params, "turnId"),
      });
    case "thread/goal/updated":
      return appServerTimelineEntry({
        stream: AppServerTimelineStreams.State,
        kind: "goal_updated",
        receivedAt,
        params,
      });
    case "thread/goal/cleared":
      return appServerTimelineEntry({
        stream: AppServerTimelineStreams.State,
        kind: "goal_cleared",
        receivedAt,
        params,
      });
    case "turn/plan/updated":
      return appServerTimelineEntry({
        stream: AppServerTimelineStreams.Plan,
        kind: "plan_updated",
        receivedAt,
        params,
        turnId: readString(params, "turnId"),
      });
    case "item/plan/delta":
      return appServerTimelineEntry({
        stream: AppServerTimelineStreams.Plan,
        kind: "plan_delta",
        receivedAt,
        params,
        turnId: readString(params, "turnId"),
      });
    case "item/started":
    case "item/completed": {
      const item = readObjectOrUndefined(params.item);
      return appServerTimelineEntry({
        stream: AppServerTimelineStreams.Item,
        kind: notification.method === "item/started" ? "item_started" : "item_completed",
        receivedAt,
        params,
        turnId: readString(params, "turnId"),
        itemId: readString(item, "id"),
      });
    }
    case "item/agentMessage/delta":
      return appServerTimelineEntry({
        stream: AppServerTimelineStreams.Item,
        kind: "agent_message_delta",
        receivedAt,
        params,
        turnId: readString(params, "turnId"),
      });
    case "serverRequest/resolved":
      return undefined;
    default:
      return undefined;
  }
}

function appServerTimelineEntry(input: {
  stream: AppServerTimelineStream;
  kind: string;
  receivedAt: string;
  params: Record<string, unknown>;
  turnId?: string;
  itemId?: string;
}): Omit<AppServerTimelineEntry, "seq"> | undefined {
  const threadId = readString(input.params, "threadId");
  if (!threadId) return undefined;
  return {
    stream: input.stream,
    kind: input.kind,
    receivedAt: input.receivedAt,
    threadId,
    turnId: input.turnId,
    itemId: input.itemId,
  };
}

function toProgressItem(input: {
  threadId: string;
  turnId: string;
  item: AppServerItem;
  updatedAt: string;
}): AppServerProgressItem | undefined {
  if (!isProgressSourceItem(input.item)) {
    return undefined;
  }
  return {
    itemId: input.item.id,
    threadId: input.threadId,
    turnId: input.turnId,
    type: input.item.type,
    status: input.item.status,
    label: progressLabel(input.item),
    detail: progressDetail(input.item),
    item: input.item,
    updatedAt: input.updatedAt,
  };
}

function progressLabel(item: AppServerProgressSourceItem): string {
  switch (item.type) {
    case "commandExecution":
      return item.command;
    case "dynamicToolCall":
      return item.tool;
    case "mcpToolCall":
      return `${item.server}.${item.tool}`;
  }
}

function progressDetail(item: AppServerProgressSourceItem): string | undefined {
  switch (item.type) {
    case "commandExecution":
      return item.cwd;
    case "dynamicToolCall":
    case "mcpToolCall":
      return item.arguments === undefined ? undefined : JSON.stringify(item.arguments);
  }
}

function normalizeItem(value: unknown): AppServerItem | undefined {
  const raw = readObjectOrUndefined(value);
  const id = readString(raw, "id");
  const type = readString(raw, "type");
  if (!raw || !id || !type) return undefined;

  switch (type) {
    case "agentMessage":
      return {
        ...raw,
        id,
        type,
        text: readString(raw, "text") ?? "",
        phase: readString(raw, "phase") ?? null,
      };
    case "plan":
      return {
        ...raw,
        id,
        type,
        text: readString(raw, "text") ?? "",
      };
    case "reasoning":
      return {
        ...raw,
        id,
        type,
        summary: readStringArray(raw.summary),
        content: readStringArray(raw.content),
      };
    case "commandExecution":
      return {
        ...raw,
        id,
        type,
        command: readString(raw, "command") ?? "command",
        cwd: readString(raw, "cwd"),
        status: readStatus(raw),
        exitCode: readNumberOrNull(raw, "exitCode"),
        stdout: readString(raw, "stdout"),
        stderr: readString(raw, "stderr"),
        durationMs: readNumberOrNull(raw, "durationMs"),
      };
    case "dynamicToolCall":
      return {
        ...raw,
        id,
        type,
        tool: readString(raw, "tool") ?? "dynamic tool",
        arguments: raw.arguments,
        status: readStatus(raw),
        contentItems: readArrayOrNull(raw.contentItems),
        success: readBooleanOrNull(raw, "success"),
        durationMs: readNumberOrNull(raw, "durationMs"),
      };
    case "mcpToolCall":
      return {
        ...raw,
        id,
        type,
        server: readString(raw, "server") ?? "mcp",
        tool: readString(raw, "tool") ?? "tool",
        arguments: raw.arguments,
        status: readStatus(raw),
        result: raw.result,
        error: raw.error,
        durationMs: readNumberOrNull(raw, "durationMs"),
      };
    case "fileChange":
      return {
        ...raw,
        id,
        type,
        changes: readArray(raw.changes),
        status: readString(raw, "status"),
      };
    default:
      return {
        id,
        type: "unknown",
        rawType: type,
        status: readString(raw, "status"),
        raw: cloneJson(raw),
      };
  }
}

function normalizePlanStep(value: unknown): AppServerPlanStep | undefined {
  const raw = readObjectOrUndefined(value);
  if (!raw) return undefined;
  return {
    step: readString(raw, "step") ?? "",
    status: readString(raw, "status") ?? "pending",
    raw: cloneJson(raw),
  };
}

function normalizeGoal(value: unknown, fallbackThreadId?: string): AppServerThreadGoalState | undefined {
  const raw = readObjectOrUndefined(value);
  if (!raw) return undefined;
  const threadId = readString(raw, "threadId") ?? fallbackThreadId;
  const objective = readString(raw, "objective");
  if (!threadId || !objective) return undefined;
  return {
    threadId,
    objective,
    status: readString(raw, "status") ?? "active",
    tokenBudget: readNumber(raw, "tokenBudget"),
    tokensUsed: readNumber(raw, "tokensUsed"),
    timeUsedSeconds: readNumber(raw, "timeUsedSeconds"),
    createdAt: readNumber(raw, "createdAt"),
    updatedAt: readNumber(raw, "updatedAt"),
    raw: cloneJson(raw),
  };
}

function isProgressSourceItem(item: AppServerItem): item is AppServerProgressSourceItem {
  return item.type === "commandExecution"
    || item.type === "dynamicToolCall"
    || item.type === "mcpToolCall";
}

function isResponse(value: unknown): value is JsonRpcResponse {
  return isRecord(value)
    && typeof value.id === "number"
    && !("method" in value);
}

function isServerRequest(value: unknown): value is JsonRpcServerRequest {
  return isRecord(value)
    && (typeof value.id === "number" || typeof value.id === "string")
    && typeof value.method === "string";
}

function readObjectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(object: Record<string, unknown> | undefined, key: string): string | undefined {
  return typeof object?.[key] === "string" ? object[key] : undefined;
}

function readStatus(object: Record<string, unknown>): AppServerItemStatus {
  return readString(object, "status") ?? "unknown";
}

function readNumber(object: Record<string, unknown> | undefined, key: string): number | undefined {
  return typeof object?.[key] === "number" ? object[key] : undefined;
}

function readNumberOrNull(object: Record<string, unknown>, key: string): number | null | undefined {
  if (object[key] === null) return null;
  return readNumber(object, key);
}

function readBooleanOrNull(object: Record<string, unknown>, key: string): boolean | null | undefined {
  if (object[key] === null) return null;
  return typeof object[key] === "boolean" ? object[key] : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readArrayOrNull(value: unknown): unknown[] | null | undefined {
  if (value === null) return null;
  return Array.isArray(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
