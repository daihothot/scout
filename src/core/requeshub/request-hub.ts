import { randomUUID } from "node:crypto";
import type { RequestRegistrationOptions, RequestSnapshot, RequestType } from "./types.js";

interface RegisteredRequest {
  readonly type: object;
  snapshot: RequestSnapshot<object, object>;
  callback?(result: object): void | Promise<void>;
}

/** Run-lifetime, in-memory request records. Consumers own decisions and validity. */
export class RequestHub {
  private readonly requests = new Map<string, RegisteredRequest>();
  private closed = false;

  register<TPayload extends object, TResult extends object>(
    type: RequestType<TPayload, TResult>,
    payload: NoInfer<TPayload>,
    options: RequestRegistrationOptions<NoInfer<TResult>> = {},
  ): RequestSnapshot<TPayload, TResult> {
    if (this.closed) throw new Error("RequestHub is closed.");
    const storedPayload = structuredClone(payload);
    if (!type.isPayload(storedPayload)) throw new Error(`Invalid ${type.name} request payload.`);
    const snapshot: RequestSnapshot<TPayload, TResult> = {
      requestId: randomUUID(), type: type.name, payload: storedPayload,
      createdAt: new Date().toISOString(), status: "pending",
    };
    const callback = options.callback;
    this.requests.set(snapshot.requestId, {
      type,
      snapshot,
      ...(callback ? {
        callback: (result: object) => {
          if (!type.isResult(result)) throw new Error(`Invalid ${type.name} callback result.`);
          return callback(result);
        },
      } : {}),
    });
    return structuredClone(snapshot);
  }

  get<TPayload extends object, TResult extends object>(
    type: RequestType<TPayload, TResult>,
    requestId: string,
  ): RequestSnapshot<TPayload, TResult> | undefined {
    const entry = this.requests.get(requestId);
    // Contract identity is checked before narrowing heterogeneous stored data.
    if (!entry || entry.type !== type) return undefined;
    const snapshot = structuredClone(entry.snapshot);
    if (!type.isPayload(snapshot.payload)) throw new Error(`Invalid stored ${type.name} payload.`);
    if (snapshot.status === "completed") {
      if (!type.isResult(snapshot.result)) throw new Error(`Invalid stored ${type.name} result.`);
      return { ...snapshot, payload: snapshot.payload, result: snapshot.result };
    }
    return { ...snapshot, payload: snapshot.payload };
  }

  /** Commits synchronously; the returned promise concerns only the optional callback. */
  complete<TPayload extends object, TResult extends object>(
    type: RequestType<TPayload, TResult>,
    requestId: string,
    result: NoInfer<TResult>,
  ): Promise<void> {
    if (this.closed) throw new Error("RequestHub is closed.");
    const entry = this.requests.get(requestId);
    if (!entry || entry.type !== type) throw new Error(`Unknown ${type.name} request: ${requestId}`);
    if (entry.snapshot.status !== "pending") throw new Error(`Request ${requestId} is ${entry.snapshot.status}.`);
    const storedResult = structuredClone(result);
    if (!type.isResult(storedResult)) throw new Error(`Invalid ${type.name} request result.`);
    entry.snapshot = {
      ...entry.snapshot, status: "completed", completedAt: new Date().toISOString(), result: storedResult,
    };
    return Promise.resolve().then(() => entry.callback?.(structuredClone(storedResult)));
  }

  /** Expires only pending records; completed facts and all records remain available. */
  expire(requestId: string, reason: string): boolean {
    const entry = this.requests.get(requestId);
    if (!entry || entry.snapshot.status !== "pending") return false;
    entry.snapshot = { ...entry.snapshot, status: "expired", expiredAt: new Date().toISOString(), reason };
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const requestId of this.requests.keys()) this.expire(requestId, "request_hub_closed");
  }
}
