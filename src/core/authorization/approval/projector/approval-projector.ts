import { isDeepStrictEqual } from "node:util";
import type { AuthorizationRecord, ScoutRequestRecord, RequestRegisteredRecord, RequestExpiredRecord, ApprovalRecord } from "../../record/authorization-record.js";
import { RequestEvents } from "../../request/request-events.js";
import { ApprovalEvents } from "../approval-events.js";
import type { Approval } from "../types.js";

/** Validates stored new-approval relationships and produces complete runtime decisions. */
export class ApprovalProjector {
  project(records: readonly AuthorizationRecord[], workflowId: string): Approval[] {
    const requests = new Map<string, ScoutRequestRecord>();
    const active = new Set<string>();
    const approvals: Approval[] = [];
    const consumed = new Map<string, number>();
    for (const record of records) {
      if (record.key.routeKey === RequestEvents.authorizationRequest.registered.routeKey) {
        const { request } = record.payload as RequestRegisteredRecord;
        requests.set(request.requestId, request);
        active.add(request.requestId);
      } else if (record.key.routeKey === RequestEvents.authorizationRequest.expired.routeKey) {
        active.delete((record.payload as RequestExpiredRecord).requestId);
      } else if (record.key.routeKey === ApprovalEvents.authorizationApproval.submitted.routeKey) {
        const stored = record.payload as ApprovalRecord;
        const request = requests.get(stored.requestId);
        if (!request || !active.has(request.requestId) || request.type !== stored.requestType
          || request.workflowId !== workflowId || stored.workflowId !== workflowId) throw new Error(`Approval has no active request: ${stored.requestId}`);
        if (stored.result.decision === "approved") {
          const result = stored.result;
          if (!request.allowedGrants.some((grant) => isDeepStrictEqual(grant.scope, result.scope)
            && isDeepStrictEqual(grant.target, result.target))) throw new Error("Invalid persisted approval grant.");
          const count = consumed.get(request.requestId) ?? 0;
          if (count >= request.maxConsumptions) throw new Error("Persisted approval exceeds request quota.");
          consumed.set(request.requestId, count + 1);
        }
        const identity = { approvalId: stored.approvalId, requestId: stored.requestId,
          requestType: stored.requestType, workflowId: stored.workflowId, submittedAt: stored.submittedAt,
          consumer: structuredClone(stored.consumer) };
        approvals.push(stored.result.decision === "approved"
          ? { ...identity, result: structuredClone(stored.result), basis: { kind: "new" } }
          : { ...identity, result: structuredClone(stored.result), basis: { kind: "denied" } });
      }
    }
    return approvals;
  }
}
