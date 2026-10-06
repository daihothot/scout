import type { ScoutRequestSourceRecord } from "../record/authorization-record.js";
import type { ScoutRequest } from "../types.js";

/** A Workflow-owned authority basis; producer-specific facts belong to its concrete source contract. */
export interface ScoutRequestSource {
  readonly sourceId: string;
  readonly sourceKey: string;
  readonly type: string;
  readonly workflowId: string;
  readonly createdAt: string;
  /** New-approval allowance; null is unlimited. Credential uses and denials do not spend it. */
  readonly maxApprovals: number | null;
  readonly allowedGrants: readonly { readonly scope: object; readonly target: object }[];
  readonly state:
    | { readonly status: "active" }
    | { readonly status: "expired"; readonly expiredAt: string; readonly reason: string };
}

/** Concrete record codecs and runtime projection are installed before recovery. */
export interface RequestSourceType<TReq extends ScoutRequestSource, TRecord extends ScoutRequestSourceRecord = ScoutRequestSourceRecord, TApplication extends ScoutRequest = ScoutRequest> {
  readonly name: TReq["type"];
  encode(value: TReq): TRecord;
  decode(value: ScoutRequestSourceRecord): TRecord;
  project(value: TRecord): TReq;
  decodeGrant(value: { readonly scope: object; readonly target: object }): TReq["allowedGrants"][number];
  /** Concrete policy: match an application to its source-defined business grant. */
  match(source: TReq, request: TApplication): TReq["allowedGrants"][number] | undefined;
  /** Resolves an approved scope/target to the source's reusable business grant. */
  resolveGrant(source: TReq, grant: TReq["allowedGrants"][number]): TReq["allowedGrants"][number] | undefined;
}

export type SourceRegistration<TReq extends ScoutRequestSource> = Omit<
  TReq, "type" | "sourceId" | "workflowId" | "createdAt" | "state"
>;
