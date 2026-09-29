import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { RequestHub, RequestRegistrationOptions, RequestSnapshot, RequestType } from "../index.js";

/** A concrete read-only filesystem request, independent of agents and providers. */
export interface PermissionRequest {
  readonly access: "read";
  readonly path: string;
}

/** An approval fact; granting access in a provider remains the consumer's responsibility. */
export type PermissionApprovalResult =
  | { readonly decision: "approved" }
  | { readonly decision: "denied"; readonly reason: string };

/** Registers a concrete existing target without granting any permissions. */
export function registerPermissionRequest<TRequest extends PermissionRequest>(
  hub: RequestHub,
  type: RequestType<TRequest, PermissionApprovalResult>,
  request: NoInfer<TRequest>,
  options: RequestRegistrationOptions<PermissionApprovalResult> = {},
): RequestSnapshot<TRequest, PermissionApprovalResult> {
  if (request.access !== "read") throw new Error("Only read permission requests are supported.");
  if (!isAbsolute(request.path)) throw new Error("Permission request path must be absolute.");
  return hub.register(type, { ...request, path: realpathSync(request.path) }, options);
}
