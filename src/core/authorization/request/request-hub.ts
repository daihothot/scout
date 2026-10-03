import { randomUUID } from "node:crypto";
import type { RequestRegistration, RequestType, ScoutRequest } from "./types.js";
import type { ScoutRequestRecord } from "../record/authorization-record.js";

/** Owns runtime request identities and lifetimes, never a Journal or approval policy. */
export class RequestHub {
  private readonly requests = new Map<string, ScoutRequest>();
  private started = false;
  private closed = false;

  constructor(private readonly contracts: Map<string, RequestType<ScoutRequest>>) {}

  start(): void {
    if (this.closed) throw new Error("RequestHub is closed.");
    this.started = true;
  }
  restore(runtimeObjects: readonly ScoutRequest[]): void {
    this.requests.clear();
    for (const request of runtimeObjects) this.requests.set(request.requestId, request);
  }
  clearWorkflow(): void { this.requests.clear(); }

  bind<TReq extends ScoutRequest, TRecord extends ScoutRequestRecord>(type: RequestType<TReq, TRecord>): void {
    const bound = this.contracts.get(type.name);
    if (bound && bound !== type) throw new Error(`Request contract already bound: ${type.name}`);
    this.contracts.set(type.name, type);
  }

  register<TReq extends ScoutRequest, TRecord extends ScoutRequestRecord>(
    type: RequestType<TReq, TRecord>, input: NoInfer<RequestRegistration<TReq>>, workflowId: string,
  ): TReq {
    this.assertStarted();
    this.bind(type);
    if (!Number.isSafeInteger(input.maxConsumptions) || input.maxConsumptions < 1) {
      throw new Error("Request maxConsumptions must be a positive safe integer.");
    }
    // The generic constructor supplies all common fields; concrete input remains strongly typed.
    return { ...structuredClone(input), type: type.name, requestId: randomUUID(), workflowId,
      createdAt: new Date().toISOString(), state: { status: "active" } } as TReq;
  }
  accept(request: ScoutRequest): void { this.requests.set(request.requestId, structuredClone(request)); }

  get<TReq extends ScoutRequest, TRecord extends ScoutRequestRecord>(type: RequestType<TReq, TRecord>, requestId: string): TReq | undefined {
    const request = this.requests.get(requestId);
    if (!request || request.type !== type.name || this.contracts.get(type.name) !== type) return undefined;
    // Type erasure is confined to heterogeneous runtime storage, never decoding on query.
    return structuredClone(request) as TReq;
  }
  find(requestId: string): ScoutRequest | undefined {
    const request = this.requests.get(requestId);
    return request ? structuredClone(request) : undefined;
  }
  require<TReq extends ScoutRequest>(request: TReq): TReq {
    const stored = this.requests.get(request.requestId);
    if (!stored || stored.type !== request.type) throw new Error(`Unknown request: ${request.requestId}`);
    return structuredClone(stored) as TReq;
  }
  list(): readonly ScoutRequest[] { return [...this.requests.values()].map((request) => structuredClone(request)); }

  expire(requestId: string, reason: string, expiredAt: string): void {
    const request = this.requests.get(requestId)!;
    this.requests.set(requestId, { ...request, state: { status: "expired", reason, expiredAt } });
  }
  stop(): void { this.closed = true; }
  private assertStarted(): void {
    if (this.closed) throw new Error("RequestHub is closed.");
    if (!this.started) throw new Error("RequestHub is not started.");
  }
}
