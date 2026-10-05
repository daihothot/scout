import type { RecordEvent } from "../../record/index.js";
import type { RequestSourceType, ScoutRequestSource } from "../request-source/types.js";
import type { ApprovalResult } from "../approval/types.js";
import { RequestSourceEvents } from "../request-source/request-source-events.js";
import { ApprovalEvents } from "../approval/approval-events.js";
import { CredentialEvents } from "../credential/credential-events.js";

/** Decoded registration data, before a projector creates the runtime request. */
export interface ScoutRequestSourceRecord {
  readonly sourceId: string;
  readonly sourceKey: string;
  readonly type: string;
  readonly workflowId: string;
  readonly createdAt: string;
  readonly maxApprovals: number | null;
  readonly allowedGrants: readonly { readonly scope: object; readonly target: object }[];
  readonly state: { readonly status: "active" };
}
export interface RequestSourceRegisteredRecord { readonly source: ScoutRequestSourceRecord }
export interface RequestSourceExpiredRecord {
  readonly sourceId: string; readonly workflowId: string; readonly reason: string;
}
export interface ApprovalRecord {
  readonly approvalId: string; readonly sourceId: string; readonly sourceType: string;
  readonly workflowId: string; readonly submittedAt: string; readonly consumer: object;
  readonly result: ApprovalResult;
  readonly basis: { readonly kind: "new" } | { readonly kind: "denied" };
}
export interface CredentialUseRecord {
  readonly credentialId: string; readonly approvalId: string; readonly sourceId: string;
  readonly workflowId: string; readonly usedAt: string; readonly consumer: object;
}
export type AuthorizationRecord =
  | RecordEvent<RequestSourceRegisteredRecord, "system.authorization_request_source.registered">
  | RecordEvent<RequestSourceExpiredRecord, "system.authorization_request_source.expired">
  | RecordEvent<ApprovalRecord, "system.authorization_approval.submitted">
  | RecordEvent<CredentialUseRecord, "system.authorization_credential.used">;

/** External storage is decoded here, including producer-specific request fields. */
export function decodeAuthorizationRecords(
  records: readonly RecordEvent[],
  contracts: ReadonlyMap<string, RequestSourceType<ScoutRequestSource>>,
): AuthorizationRecord[] {
  const ids = new Set<string>();
  return records.map((fact) => {
    if (ids.has(fact.id)) throw new Error(`Duplicate authorization fact: ${fact.id}`);
    ids.add(fact.id);
    const value = fact.payload;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid authorization record.");
    let payload: RequestSourceRegisteredRecord | RequestSourceExpiredRecord | ApprovalRecord | CredentialUseRecord;
    if (fact.key.routeKey === RequestSourceEvents.authorizationRequestSource.registered.routeKey) {
      if (!("source" in value) || !value.source || typeof value.source !== "object") throw new Error("Invalid request registration.");
      const request = value.source;
      if (!("sourceId" in request) || typeof request.sourceId !== "string" || !request.sourceId
        || !("sourceKey" in request) || typeof request.sourceKey !== "string" || !request.sourceKey
        || !("type" in request) || typeof request.type !== "string" || !request.type
        || !("workflowId" in request) || typeof request.workflowId !== "string" || !request.workflowId
        || !("createdAt" in request) || typeof request.createdAt !== "string" || !Number.isFinite(Date.parse(request.createdAt))
        || !("maxApprovals" in request) || (request.maxApprovals !== null
          && (typeof request.maxApprovals !== "number" || !Number.isSafeInteger(request.maxApprovals) || request.maxApprovals < 1))
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
      payload = { source: contract.decode(structuredClone(request) as ScoutRequestSourceRecord) };
    } else if (fact.key.routeKey === RequestSourceEvents.authorizationRequestSource.expired.routeKey) {
      if (!("sourceId" in value) || typeof value.sourceId !== "string"
        || !("workflowId" in value) || typeof value.workflowId !== "string"
        || !("reason" in value) || typeof value.reason !== "string" || !value.reason) throw new Error("Invalid request expiry.");
      payload = { sourceId: value.sourceId, workflowId: value.workflowId, reason: value.reason };
    } else if (fact.key.routeKey === ApprovalEvents.authorizationApproval.submitted.routeKey) {
      if (!("approvalId" in value) || value.approvalId !== fact.id
        || !("submittedAt" in value) || value.submittedAt !== fact.occurredAt
        || !("sourceId" in value) || typeof value.sourceId !== "string"
        || !("sourceType" in value) || typeof value.sourceType !== "string"
        || !("workflowId" in value) || typeof value.workflowId !== "string"
        || !("consumer" in value) || !value.consumer || typeof value.consumer !== "object" || Array.isArray(value.consumer)
        || !("result" in value) || !value.result || typeof value.result !== "object"
        || !("basis" in value) || !value.basis || typeof value.basis !== "object" || !("kind" in value.basis)) throw new Error("Invalid approval record.");
      const result = value.result;
      const basis = value.basis;
      const identity = {
        approvalId: fact.id, submittedAt: fact.occurredAt, sourceId: value.sourceId,
        sourceType: value.sourceType, workflowId: value.workflowId, consumer: structuredClone(value.consumer),
      };
      if (!("decision" in result)) throw new Error("Invalid approval result.");
      if (result.decision === "denied") {
        if (basis.kind !== "denied" || !("reason" in result) || typeof result.reason !== "string" || !result.reason) throw new Error("Invalid denied approval record.");
        payload = { ...identity, result: { decision: "denied", reason: result.reason }, basis: { kind: "denied" } };
      } else if (result.decision === "approved") {
        if (basis.kind !== "new"
          || !("scope" in result) || !result.scope || typeof result.scope !== "object" || Array.isArray(result.scope)
          || !("target" in result) || !result.target || typeof result.target !== "object" || Array.isArray(result.target)) throw new Error("Invalid persisted approval grant.");
        const contract = contracts.get(value.sourceType);
        if (!contract) throw new Error(`Unknown stored request source contract: ${value.sourceType}`);
        payload = { ...identity,
          result: { decision: "approved", ...contract.decodeGrant({ scope: result.scope, target: result.target }) },
          basis: { kind: "new" },
        };
      } else throw new Error("Invalid approval decision.");
    } else if (fact.key.routeKey === CredentialEvents.authorizationCredential.used.routeKey) {
      if (!("approvalId" in value) || value.approvalId !== fact.id
        || !("usedAt" in value) || value.usedAt !== fact.occurredAt
        || !("credentialId" in value) || typeof value.credentialId !== "string"
        || !("sourceId" in value) || typeof value.sourceId !== "string"
        || !("workflowId" in value) || typeof value.workflowId !== "string"
        || !("consumer" in value) || !value.consumer || typeof value.consumer !== "object" || Array.isArray(value.consumer)) throw new Error("Invalid credential use record.");
      payload = { credentialId: value.credentialId, approvalId: value.approvalId, sourceId: value.sourceId,
        workflowId: value.workflowId, usedAt: value.usedAt, consumer: structuredClone(value.consumer) };
    } else throw new Error(`Unknown authorization event: ${fact.key.routeKey}`);
    // The route and its fully decoded payload are narrowed together at the file boundary.
    return { ...fact, payload } as AuthorizationRecord;
  });
}
