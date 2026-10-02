import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { EventType, ScoutEvent } from "../events/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { RequestHubRecordObject } from "./request-hub-record-object.js";
import type { ScoutWorkflowParticipant, WorkflowData } from "../workflow/index.js";
import { RequestHubEvents } from "./request-hub-events.js";
import type { RequestRegistrationOptions, RequestSnapshot, RequestType } from "./types.js";

interface RegisteredRequest {
  snapshot: RequestSnapshot<object, object>;
  callback?(result: object): void | Promise<void>;
}

/** Durable request records and processing results. Consumers own decisions and validity. */
export class RequestHub implements ScoutWorkflowParticipant {
  private readonly requests = new Map<string, RegisteredRequest>();
  private readonly contracts = new Map<string, object>();
  readonly recordObject = new RequestHubRecordObject();
  private started = false;
  private closed = false;

  /** Rebuilds request state only; starting the service never invokes a business callback. */
  start(): void {
    if (this.closed) throw new Error("RequestHub is closed.");
    if (this.started) return;
    this.recordObject.start();
    try {
      for (const event of this.recordObject.readFacts()) {
        const snapshot = this.project(event);
        this.requests.set(snapshot.requestId, { snapshot });
      }
      this.started = true;
    } catch (error) {
      this.requests.clear();
      this.recordObject.close();
      throw error;
    }
  }

  register<TPayload extends object, TResult extends object>(
    type: RequestType<TPayload, TResult>,
    payload: NoInfer<TPayload>,
    options: RequestRegistrationOptions<NoInfer<TResult>> = {},
  ): RequestSnapshot<TPayload, TResult> {
    const bound = this.contracts.get(type.name);
    if (bound && bound !== type) throw new Error(`Request contract already bound: ${type.name}`);
    const storedPayload = cloneRequestData(payload);
    if (!type.isPayload(storedPayload)) throw new Error(`Invalid ${type.name} request payload.`);
    const snapshot = this.record(RequestHubEvents.requestHub.registered, {
      requestId: randomUUID(), type: type.name, payload: storedPayload, consumption: options.consumption ?? "single",
    });
    this.contracts.set(type.name, type);
    const callback = options.callback;
    this.requests.set(snapshot.requestId, {
      snapshot,
      ...(callback ? {
        callback: (result: object) => {
          if (!type.isResult(result)) throw new Error(`Invalid ${type.name} callback result.`);
          return callback(result);
        },
      } : {}),
    });
    return this.get(type, snapshot.requestId)!;
  }

  get<TPayload extends object, TResult extends object>(
    type: RequestType<TPayload, TResult>,
    requestId: string,
  ): RequestSnapshot<TPayload, TResult> | undefined {
    const entry = this.requests.get(requestId);
    if (!entry || entry.snapshot.type !== type.name) return undefined;
    const bound = this.contracts.get(type.name);
    if (bound && bound !== type) return undefined;
    const snapshot = structuredClone(entry.snapshot);
    if (!type.isPayload(snapshot.payload)) throw new Error(`Invalid stored ${type.name} payload.`);
    // A restored contract is bound by name only after all of its data passes the
    // current host validators. No executable code or object identity is deserialized.
    if (snapshot.consumption === "multiple") {
      const completions = snapshot.completions.map((completion) => {
        if (!type.isResult(completion.result)) throw new Error(`Invalid stored ${type.name} result.`);
        return { ...completion, result: completion.result };
      });
      this.contracts.set(type.name, type);
      return { ...snapshot, payload: snapshot.payload, completions };
    }
    if (snapshot.status === "completed") {
      if (!type.isResult(snapshot.result)) throw new Error(`Invalid stored ${type.name} result.`);
      this.contracts.set(type.name, type);
      return { ...snapshot, payload: snapshot.payload, result: snapshot.result };
    }
    this.contracts.set(type.name, type);
    return { ...snapshot, payload: snapshot.payload };
  }

  /** Commits synchronously; the returned promise concerns only the optional callback. */
  complete<TPayload extends object, TResult extends object>(
    type: RequestType<TPayload, TResult>,
    requestId: string,
    result: NoInfer<TResult>,
  ): Promise<void> {
    if (this.closed) throw new Error("RequestHub is closed.");
    const snapshot = this.get(type, requestId);
    if (!snapshot) throw new Error(`Unknown ${type.name} request: ${requestId}`);
    if (snapshot.status !== "pending") throw new Error(`Request ${requestId} is ${snapshot.status}.`);
    const storedResult = cloneRequestData(result);
    if (!type.isResult(storedResult)) throw new Error(`Invalid ${type.name} request result.`);
    this.record(RequestHubEvents.requestHub.completed, { requestId, result: storedResult });
    const callback = this.requests.get(requestId)?.callback;
    return Promise.resolve().then(() => callback?.(structuredClone(storedResult)));
  }

  /** Expires only pending records; completed facts and all records remain available. */
  expire(requestId: string, reason: string): boolean {
    if (this.closed) throw new Error("RequestHub is closed.");
    const entry = this.requests.get(requestId);
    if (!entry || entry.snapshot.status !== "pending") return false;
    this.record(RequestHubEvents.requestHub.expired, { requestId, reason });
    return true;
  }

  create(): void {}

  /** Rebuilds existing request state during the owner-driven Workflow restore. */
  restore(_data: WorkflowData): void {
    this.recordObject.attach(currentRunScope().workflow.journalRoot);
    this.requests.clear();
    this.contracts.clear();
    for (const record of this.recordObject.readFacts()) {
      const snapshot = this.project(record);
      this.requests.set(snapshot.requestId, { snapshot });
    }
  }

  run(): void {}
  close(): void {}
  abort(): void {}
  clearWorkflow(): void { this.recordObject.release(); }

  /** Releases the service without changing the lifetime of any persisted request. */
  stop(): void {
    if (this.closed) return;
    this.recordObject.close();
    this.closed = true;
  }

  /** Validate the transition, persist it, then expose it to live consumers. */
  private record<TPayload>(key: EventType<TPayload>, payload: NoInfer<TPayload>): RequestSnapshot<object, object> {
    if (this.closed) throw new Error("RequestHub is closed.");
    if (!this.started) throw new Error("RequestHub is not started.");
    const event = { id: randomUUID(), key, payload, occurredAt: new Date().toISOString() };
    const snapshot = this.project(event);
    this.recordObject.record(event);
    this.requests.set(snapshot.requestId, { ...this.requests.get(snapshot.requestId), snapshot });
    currentRunScope().eventBus.publish(key, payload, event);
    return snapshot;
  }

  /** The same state transitions validate live writes and persisted replay. */
  private project(event: ScoutEvent): RequestSnapshot<object, object> {
    const data = event.payload;
    if (!data || typeof data !== "object" || Array.isArray(data)
      || !("requestId" in data) || typeof data.requestId !== "string" || !data.requestId.trim()
      || !event.id || !Number.isFinite(Date.parse(event.occurredAt))) {
      throw new Error("Invalid RequestHub event.");
    }
    const requestId = data.requestId;
    const previous = this.requests.get(requestId)?.snapshot;
    switch (event.key.routeKey) {
      case RequestHubEvents.requestHub.registered.routeKey: {
        if (previous) throw new Error(`Request already registered: ${requestId}`);
        if (!("type" in data) || typeof data.type !== "string" || !data.type.trim()
          || !("consumption" in data) || (data.consumption !== "single" && data.consumption !== "multiple")
          || !("payload" in data) || !data.payload || typeof data.payload !== "object") {
          throw new Error("Invalid RequestHub registration.");
        }
        const registration = {
          requestId, type: data.type, payload: cloneRequestData(data.payload), createdAt: event.occurredAt,
          status: "pending" as const,
        };
        return data.consumption === "single"
          ? { ...registration, consumption: "single" }
          : { ...registration, consumption: "multiple", completions: [] };
      }
      case RequestHubEvents.requestHub.completed.routeKey: {
        if (!previous || previous.status !== "pending") throw new Error(`Request is not pending: ${requestId}`);
        if (!("result" in data) || !data.result || typeof data.result !== "object") {
          throw new Error("Invalid RequestHub completion.");
        }
        const completion = { completionId: event.id, completedAt: event.occurredAt, result: cloneRequestData(data.result) };
        if (previous.consumption === "single") return { ...previous, status: "completed", ...completion };
        if (previous.completions.some(({ completionId }) => completionId === event.id)) {
          throw new Error(`Duplicate RequestHub completion: ${event.id}`);
        }
        return { ...previous, completions: [...previous.completions, completion] };
      }
      case RequestHubEvents.requestHub.expired.routeKey: {
        if (!previous || previous.status !== "pending") throw new Error(`Request is not pending: ${requestId}`);
        if (!("reason" in data) || typeof data.reason !== "string" || !data.reason.trim()) {
          throw new Error("Invalid RequestHub expiry reason.");
        }
        return { ...previous, status: "expired", expiredAt: event.occurredAt, reason: data.reason };
      }
      default:
        throw new Error(`Unknown RequestHub event: ${event.key.routeKey}`);
    }
  }
}

/** Reject data that would silently change shape or value when persisted as JSON. */
function cloneRequestData<T extends object>(value: T): T {
  if (!value || typeof value !== "object" || !isDeepStrictEqual(value, JSON.parse(JSON.stringify(value)))) {
    throw new Error("RequestHub payloads and results must be lossless JSON data.");
  }
  return structuredClone(value);
}
