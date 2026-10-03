import type { ScoutRequest } from "../request/types.js";

/** A projection of an original approved fact, not a restored native sandbox grant. */
export interface Credential<TReq extends ScoutRequest = ScoutRequest> {
  readonly scope: TReq["allowedGrants"][number]["scope"];
  readonly target: TReq["allowedGrants"][number]["target"];
  readonly credentialId: string;
  /** Issuing request provenance; matching uses Workflow, request type and the grant. */
  readonly requestId: string;
  readonly requestType: TReq["type"];
  readonly workflowId: string;
  readonly issuedAt: string;
}

export interface CredentialUse {
  readonly credentialId: string;
  readonly approvalId: string;
  readonly requestId: string;
  readonly workflowId: string;
  readonly usedAt: string;
  readonly consumer: object;
}
