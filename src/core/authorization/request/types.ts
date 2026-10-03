import type { ScoutRequestRecord } from "../record/authorization-record.js";

/** A Workflow-owned authorization request. Producer-specific data belongs to its concrete contract. */
export interface ScoutRequest {
  readonly requestId: string;
  readonly type: string;
  readonly workflowId: string;
  readonly createdAt: string;
  /** Counts new approvals, not denied attempts or uses of an existing credential. */
  readonly maxConsumptions: number;
  readonly allowedGrants: readonly { readonly scope: object; readonly target: object }[];
  readonly state:
    | { readonly status: "active" }
    | { readonly status: "expired"; readonly expiredAt: string; readonly reason: string };
}

/** Concrete record codecs and runtime projection are installed before recovery. */
export interface RequestType<TReq extends ScoutRequest, TRecord extends ScoutRequestRecord = ScoutRequestRecord> {
  readonly name: TReq["type"];
  encode(value: TReq): TRecord;
  decode(value: ScoutRequestRecord): TRecord;
  project(value: TRecord): TReq;
}

export type RequestRegistration<TReq extends ScoutRequest> = Omit<
  TReq, "type" | "requestId" | "workflowId" | "createdAt" | "state"
>;
