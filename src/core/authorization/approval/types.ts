import type { ScoutRequestSource } from "../request-source/types.js";

/** Both a new decision and credential-backed approval deliver this exact grant. */
export interface ApprovedResult<TReq extends ScoutRequestSource = ScoutRequestSource> {
  readonly decision: "approved";
  readonly scope: TReq["allowedGrants"][number]["scope"];
  readonly target: TReq["allowedGrants"][number]["target"];
}

export type ApprovalResult<TReq extends ScoutRequestSource = ScoutRequestSource> =
  | ApprovedResult<TReq>
  | { readonly decision: "denied"; readonly reason: string };

/** Authorization passes a matched grant to the new-approval owner. */
export interface ApprovedSubmission<TReq extends ScoutRequestSource = ScoutRequestSource> {
  readonly consumer: object;
  readonly result: ApprovedResult<TReq>;
}

export type ApprovalSubmission<TReq extends ScoutRequestSource = ScoutRequestSource> = ApprovedSubmission<TReq> | {
  readonly consumer: object;
  readonly result: { readonly decision: "denied"; readonly reason: string };
};

/** A new runtime decision; persistence records and credential uses have separate contracts. */
export type Approval<TReq extends ScoutRequestSource = ScoutRequestSource> = {
  readonly approvalId: string;
  readonly sourceId: string;
  readonly sourceType: TReq["type"];
  readonly workflowId: string;
  readonly submittedAt: string;
  readonly consumer: object;
} & (
  | { readonly result: ApprovedResult<TReq>; readonly basis: { readonly kind: "new" } }
  | { readonly result: { readonly decision: "denied"; readonly reason: string }; readonly basis: { readonly kind: "denied" } }
);
