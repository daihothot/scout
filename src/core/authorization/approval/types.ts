import type { ScoutRequest } from "../request/types.js";

/** Both a new decision and credential-backed approval deliver this exact grant. */
export interface ApprovedResult<TReq extends ScoutRequest = ScoutRequest> {
  readonly decision: "approved";
  readonly scope: TReq["allowedGrants"][number]["scope"];
  readonly target: TReq["allowedGrants"][number]["target"];
}

export type ApprovalResult<TReq extends ScoutRequest = ScoutRequest> =
  | ApprovedResult<TReq>
  | { readonly decision: "denied"; readonly reason: string };

/** A caller supplies a decision candidate; Authorization chooses its approval route. */
export interface ApprovedSubmission<TReq extends ScoutRequest = ScoutRequest> {
  readonly consumer: object;
  readonly result: ApprovedResult<TReq>;
}

export type ApprovalSubmission<TReq extends ScoutRequest = ScoutRequest> = ApprovedSubmission<TReq> | {
  readonly consumer: object;
  readonly result: { readonly decision: "denied"; readonly reason: string };
};

/** A new runtime decision; persistence records and credential uses have separate contracts. */
export type Approval<TReq extends ScoutRequest = ScoutRequest> = {
  readonly approvalId: string;
  readonly requestId: string;
  readonly requestType: TReq["type"];
  readonly workflowId: string;
  readonly submittedAt: string;
  readonly consumer: object;
} & (
  | { readonly result: ApprovedResult<TReq>; readonly basis: { readonly kind: "new" } }
  | { readonly result: { readonly decision: "denied"; readonly reason: string }; readonly basis: { readonly kind: "denied" } }
);
