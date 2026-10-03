import type { RecordEvent } from "../../record/index.js";
import type { RequestType, ScoutRequest } from "../request/types.js";
import type { ApprovalResult } from "../approval/types.js";
import { RequestEvents } from "../request/request-events.js";
import { ApprovalEvents } from "../approval/approval-events.js";
import { CredentialEvents } from "../credential/credential-events.js";

/** Decoded registration data, before a projector creates the runtime request. */
export interface ScoutRequestRecord {
  readonly requestId: string;
  readonly type: string;
  readonly workflowId: string;
  readonly createdAt: string;
  readonly maxConsumptions: number;
  readonly allowedGrants: readonly { readonly scope: object; readonly target: object }[];
  readonly state: { readonly status: "active" };
}
export interface RequestRegisteredRecord { readonly request: ScoutRequestRecord }
export interface RequestExpiredRecord {
  readonly requestId: string; readonly workflowId: string; readonly reason: string;
}
export interface ApprovalRecord {
  readonly approvalId: string; readonly requestId: string; readonly requestType: string;
  readonly workflowId: string; readonly submittedAt: string; readonly consumer: object;
  readonly result: ApprovalResult;
  readonly basis: { readonly kind: "new" } | { readonly kind: "denied" };
}
export interface CredentialUseRecord {
  readonly credentialId: string; readonly approvalId: string; readonly requestId: string;
  readonly workflowId: string; readonly usedAt: string; readonly consumer: object;
}
export type AuthorizationRecord =
  | RecordEvent<RequestRegisteredRecord, "system.authorization_request.registered">
  | RecordEvent<RequestExpiredRecord, "system.authorization_request.expired">
  | RecordEvent<ApprovalRecord, "system.authorization_approval.submitted">
  | RecordEvent<CredentialUseRecord, "system.authorization_credential.used">;

/** External storage is decoded here, including producer-specific request fields. */
export function decodeAuthorizationRecords(
  records: readonly RecordEvent[],
  contracts: ReadonlyMap<string, RequestType<ScoutRequest>>,
): AuthorizationRecord[] {
  const ids = new Set<string>();
  return records.map((fact) => {
    if (ids.has(fact.id)) throw new Error(`Duplicate authorization fact: ${fact.id}`);
    ids.add(fact.id);
    const value = fact.payload;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid authorization record.");
    let payload: RequestRegisteredRecord | RequestExpiredRecord | ApprovalRecord | CredentialUseRecord;
    if (fact.key.routeKey === RequestEvents.authorizationRequest.registered.routeKey) {
      if (!("request" in value) || !value.request || typeof value.request !== "object") throw new Error("Invalid request registration.");
      const request = value.request;
      if (!("requestId" in request) || typeof request.requestId !== "string" || !request.requestId
        || !("type" in request) || typeof request.type !== "string" || !request.type
        || !("workflowId" in request) || typeof request.workflowId !== "string" || !request.workflowId
        || !("createdAt" in request) || typeof request.createdAt !== "string" || !Number.isFinite(Date.parse(request.createdAt))
        || !("maxConsumptions" in request) || typeof request.maxConsumptions !== "number"
        || !Number.isSafeInteger(request.maxConsumptions) || request.maxConsumptions < 1
        || !("state" in request) || !request.state || typeof request.state !== "object"
        || !("status" in request.state) || request.state.status !== "active"
        || !("allowedGrants" in request) || !Array.isArray(request.allowedGrants)
        || !request.allowedGrants.every((grant: unknown) => grant !== null && typeof grant === "object"
          && "scope" in grant && grant.scope !== null && typeof grant.scope === "object" && !Array.isArray(grant.scope)
          && "target" in grant && grant.target !== null && typeof grant.target === "object" && !Array.isArray(grant.target))) {
        throw new Error("Invalid request registration.");
      }
      const contract = contracts.get(request.type);
      if (!contract) throw new Error(`Unknown stored request contract: ${request.type}`);
      // Only this storage boundary narrows the validated common registration shape.
      payload = { request: contract.decode(structuredClone(request) as ScoutRequestRecord) };
    } else if (fact.key.routeKey === RequestEvents.authorizationRequest.expired.routeKey) {
      if (!("requestId" in value) || typeof value.requestId !== "string"
        || !("workflowId" in value) || typeof value.workflowId !== "string"
        || !("reason" in value) || typeof value.reason !== "string" || !value.reason) throw new Error("Invalid request expiry.");
      payload = { requestId: value.requestId, workflowId: value.workflowId, reason: value.reason };
    } else if (fact.key.routeKey === ApprovalEvents.authorizationApproval.submitted.routeKey) {
      if (!("approvalId" in value) || value.approvalId !== fact.id
        || !("submittedAt" in value) || value.submittedAt !== fact.occurredAt
        || !("requestId" in value) || typeof value.requestId !== "string"
        || !("requestType" in value) || typeof value.requestType !== "string"
        || !("workflowId" in value) || typeof value.workflowId !== "string"
        || !("consumer" in value) || !value.consumer || typeof value.consumer !== "object" || Array.isArray(value.consumer)
        || !("result" in value) || !value.result || typeof value.result !== "object"
        || !("basis" in value) || !value.basis || typeof value.basis !== "object" || !("kind" in value.basis)) throw new Error("Invalid approval record.");
      const result = value.result;
      const basis = value.basis;
      const identity = {
        approvalId: fact.id, submittedAt: fact.occurredAt, requestId: value.requestId,
        requestType: value.requestType, workflowId: value.workflowId, consumer: structuredClone(value.consumer),
      };
      if (!("decision" in result)) throw new Error("Invalid approval result.");
      if (result.decision === "denied") {
        if (basis.kind !== "denied" || !("reason" in result) || typeof result.reason !== "string" || !result.reason) throw new Error("Invalid denied approval record.");
        payload = { ...identity, result: { decision: "denied", reason: result.reason }, basis: { kind: "denied" } };
      } else if (result.decision === "approved") {
        if (basis.kind !== "new"
          || !("scope" in result) || !result.scope || typeof result.scope !== "object" || Array.isArray(result.scope)
          || !("target" in result) || !result.target || typeof result.target !== "object" || Array.isArray(result.target)) throw new Error("Invalid persisted approval grant.");
        payload = { ...identity,
          result: { decision: "approved", scope: structuredClone(result.scope), target: structuredClone(result.target) },
          basis: { kind: "new" },
        };
      } else throw new Error("Invalid approval decision.");
    } else if (fact.key.routeKey === CredentialEvents.authorizationCredential.used.routeKey) {
      if (!("approvalId" in value) || value.approvalId !== fact.id
        || !("usedAt" in value) || value.usedAt !== fact.occurredAt
        || !("credentialId" in value) || typeof value.credentialId !== "string"
        || !("requestId" in value) || typeof value.requestId !== "string"
        || !("workflowId" in value) || typeof value.workflowId !== "string"
        || !("consumer" in value) || !value.consumer || typeof value.consumer !== "object" || Array.isArray(value.consumer)) throw new Error("Invalid credential use record.");
      payload = { credentialId: value.credentialId, approvalId: value.approvalId, requestId: value.requestId,
        workflowId: value.workflowId, usedAt: value.usedAt, consumer: structuredClone(value.consumer) };
    } else throw new Error(`Unknown authorization event: ${fact.key.routeKey}`);
    // The route and its fully decoded payload are narrowed together at the file boundary.
    return { ...fact, payload } as AuthorizationRecord;
  });
}
