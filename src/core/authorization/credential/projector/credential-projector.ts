import { isDeepStrictEqual } from "node:util";
import type { AuthorizationRecord, ScoutRequestRecord, RequestRegisteredRecord, RequestExpiredRecord, ApprovalRecord, CredentialUseRecord } from "../../record/authorization-record.js";
import { RequestEvents } from "../../request/request-events.js";
import { ApprovalEvents } from "../../approval/approval-events.js";
import { CredentialEvents } from "../credential-events.js";
import type { Credential, CredentialUse } from "../types.js";

/** Projects issuance from new approvals and validates each separately recorded use. */
export class CredentialProjector {
  project(records: readonly AuthorizationRecord[], workflowId: string): { credentials: Credential[]; usages: CredentialUse[] } {
    const requests = new Map<string, ScoutRequestRecord>();
    const active = new Set<string>();
    const credentials = new Map<string, Credential>();
    const usages: CredentialUse[] = [];
    for (const record of records) {
      if (record.key.routeKey === RequestEvents.authorizationRequest.registered.routeKey) {
        const { request } = record.payload as RequestRegisteredRecord;
        requests.set(request.requestId, request);
        active.add(request.requestId);
      } else if (record.key.routeKey === RequestEvents.authorizationRequest.expired.routeKey) {
        active.delete((record.payload as RequestExpiredRecord).requestId);
      } else if (record.key.routeKey === ApprovalEvents.authorizationApproval.submitted.routeKey) {
        const approval = record.payload as ApprovalRecord;
        if (approval.result.decision !== "approved") continue;
        credentials.set(approval.approvalId, {
          credentialId: approval.approvalId, requestId: approval.requestId, requestType: approval.requestType,
          workflowId: approval.workflowId, issuedAt: approval.submittedAt,
          scope: structuredClone(approval.result.scope), target: structuredClone(approval.result.target),
        });
      } else if (record.key.routeKey === CredentialEvents.authorizationCredential.used.routeKey) {
        const use = record.payload as CredentialUseRecord;
        const credential = credentials.get(use.credentialId);
        const request = requests.get(use.requestId);
        if (!credential || !request || !active.has(request.requestId)
          || use.workflowId !== workflowId || request.workflowId !== workflowId
          || credential.workflowId !== workflowId || credential.requestType !== request.type
          || !request.allowedGrants.some((grant) => isDeepStrictEqual(grant.scope, credential.scope)
            && isDeepStrictEqual(grant.target, credential.target))) throw new Error("Invalid persisted credential reference.");
        usages.push({ credentialId: use.credentialId, approvalId: use.approvalId, requestId: use.requestId,
          workflowId: use.workflowId, usedAt: use.usedAt, consumer: structuredClone(use.consumer) });
      }
    }
    return { credentials: [...credentials.values()], usages };
  }
}
