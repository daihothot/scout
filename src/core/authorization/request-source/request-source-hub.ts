import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SourceRegistration, RequestSourceType, ScoutRequestSource } from "./types.js";
import type { ScoutRequestSourceRecord } from "../record/authorization-record.js";

/** Owns runtime request identities and lifetimes, never a Journal or approval policy. */
export class RequestSourceHub {
  private readonly requests = new Map<string, ScoutRequestSource>();
  private readonly identities = new Map<string, string>();
  private started = false;
  private closed = false;

  constructor(private readonly contracts: Map<string, RequestSourceType<ScoutRequestSource>>) {}

  start(): void {
    if (this.closed) throw new Error("RequestSourceHub is closed.");
    this.started = true;
  }
  restore(runtimeObjects: readonly ScoutRequestSource[]): void {
    this.requests.clear();
    this.identities.clear();
    for (const request of runtimeObjects) this.accept(request);
  }
  clearWorkflow(): void { this.requests.clear(); this.identities.clear(); }

  bind<TReq extends ScoutRequestSource, TRecord extends ScoutRequestSourceRecord>(type: RequestSourceType<TReq, TRecord>): void {
    const bound = this.contracts.get(type.name);
    if (bound && bound !== type) throw new Error(`Request contract already bound: ${type.name}`);
    this.contracts.set(type.name, type);
  }

  register<TReq extends ScoutRequestSource, TRecord extends ScoutRequestSourceRecord>(
    type: RequestSourceType<TReq, TRecord>, input: NoInfer<SourceRegistration<TReq>>, workflowId: string,
  ): TReq {
    this.assertStarted();
    this.bind(type);
    const identity = JSON.stringify([workflowId, type.name, input.sourceKey]);
    const existingId = this.identities.get(identity);
    if (existingId) {
      const existing = this.get(type, existingId)!;
      if (existing.maxApprovals !== input.maxApprovals || !isDeepStrictEqual(existing.allowedGrants, input.allowedGrants)) {
        throw new Error(`Request source registration conflict: ${input.sourceKey}`);
      }
      return existing;
    }
    // The generic constructor supplies all common fields; concrete input remains strongly typed.
    return { ...structuredClone(input), type: type.name, sourceId: randomUUID(), workflowId,
      createdAt: new Date().toISOString(), state: { status: "active" } } as TReq;
  }
  accept(request: ScoutRequestSource): void {
    this.requests.set(request.sourceId, structuredClone(request));
    this.identities.set(JSON.stringify([request.workflowId, request.type, request.sourceKey]), request.sourceId);
  }

  get<TReq extends ScoutRequestSource, TRecord extends ScoutRequestSourceRecord>(type: RequestSourceType<TReq, TRecord>, sourceId: string): TReq | undefined {
    const request = this.requests.get(sourceId);
    if (!request || request.type !== type.name || this.contracts.get(type.name) !== type) return undefined;
    // Type erasure is confined to heterogeneous runtime storage, never decoding on query.
    return structuredClone(request) as TReq;
  }
  find(sourceId: string): ScoutRequestSource | undefined {
    const request = this.requests.get(sourceId);
    return request ? structuredClone(request) : undefined;
  }
  require<TReq extends ScoutRequestSource>(request: TReq): TReq {
    const stored = this.requests.get(request.sourceId);
    if (!stored || stored.type !== request.type) throw new Error(`Unknown request: ${request.sourceId}`);
    return structuredClone(stored) as TReq;
  }
  list(): readonly ScoutRequestSource[] { return [...this.requests.values()].map((request) => structuredClone(request)); }

  ofType<TReq extends ScoutRequestSource, TRecord extends ScoutRequestSourceRecord>(type: RequestSourceType<TReq, TRecord>): readonly TReq[] {
    if (this.contracts.get(type.name) !== type) return [];
    return [...this.requests.values()].filter((request) => request.type === type.name)
      .map((request) => structuredClone(request) as TReq);
  }

  expire(sourceId: string, reason: string, expiredAt: string): void {
    const request = this.requests.get(sourceId)!;
    this.requests.set(sourceId, { ...request, state: { status: "expired", reason, expiredAt } });
  }
  stop(): void { this.closed = true; }
  private assertStarted(): void {
    if (this.closed) throw new Error("RequestSourceHub is closed.");
    if (!this.started) throw new Error("RequestSourceHub is not started.");
  }
}
