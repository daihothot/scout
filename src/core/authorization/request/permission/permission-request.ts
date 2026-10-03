import type { Authorization } from "../../authorization.js";
import type { ScoutRequestRecord } from "../../record/authorization-record.js";
import type { RequestRegistration, RequestType, ScoutRequest } from "../types.js";

/** Permission requests pair each permitted access scope with its target. */
export interface PermissionRequest extends ScoutRequest {
  readonly allowedGrants: readonly {
    readonly scope: { readonly access: "read" };
    readonly target: object;
  }[];
}

/** Registers the producer's typed permission request without granting any permissions. */
export function registerPermissionRequest<TReq extends PermissionRequest, TRecord extends ScoutRequestRecord>(
  authorization: Authorization,
  type: RequestType<TReq, TRecord>,
  request: NoInfer<RequestRegistration<TReq>>,
): Promise<TReq> {
  return authorization.register(type, request);
}
