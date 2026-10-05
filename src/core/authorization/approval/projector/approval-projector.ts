import type { AuthorizationRecord, RequestSourceRegisteredRecord, RequestSourceExpiredRecord, ApprovalRecord } from "../../record/authorization-record.js";
import type { RequestSourceType, ScoutRequestSource } from "../../request-source/types.js";
import { RequestSourceEvents } from "../../request-source/request-source-events.js";
import { ApprovalEvents } from "../approval-events.js";
import type { Approval } from "../types.js";

/** Validates stored new-approval relationships and produces complete runtime decisions. */
export class ApprovalProjector {
  constructor(private readonly contracts: ReadonlyMap<string, RequestSourceType<ScoutRequestSource>>) {}
  project(records: readonly AuthorizationRecord[], workflowId: string): Approval[] {
    const requests = new Map<string, ScoutRequestSource>();
    const active = new Set<string>();
    const approvals: Approval[] = [];
    const consumed = new Map<string, number>();
    for (const record of records) {
      if (record.key.routeKey === RequestSourceEvents.authorizationRequestSource.registered.routeKey) {
        const { source } = record.payload as RequestSourceRegisteredRecord;
        const request = this.contracts.get(source.type)!.project(source);
        requests.set(request.sourceId, request);
        active.add(request.sourceId);
      } else if (record.key.routeKey === RequestSourceEvents.authorizationRequestSource.expired.routeKey) {
        active.delete((record.payload as RequestSourceExpiredRecord).sourceId);
      } else if (record.key.routeKey === ApprovalEvents.authorizationApproval.submitted.routeKey) {
        const stored = record.payload as ApprovalRecord;
        const request = requests.get(stored.sourceId);
        if (!request || !active.has(request.sourceId) || request.type !== stored.sourceType
          || request.workflowId !== workflowId || stored.workflowId !== workflowId) throw new Error(`Approval has no active request: ${stored.sourceId}`);
        if (stored.result.decision === "approved") {
          const result = stored.result;
          if (!this.contracts.get(request.type)!.covers(request, result)) throw new Error("Invalid persisted approval grant.");
          const count = consumed.get(request.sourceId) ?? 0;
          if (request.maxApprovals !== null && count >= request.maxApprovals) throw new Error("Persisted approval exceeds request quota.");
          consumed.set(request.sourceId, count + 1);
        }
        const identity = { approvalId: stored.approvalId, sourceId: stored.sourceId,
          sourceType: stored.sourceType, workflowId: stored.workflowId, submittedAt: stored.submittedAt,
          consumer: structuredClone(stored.consumer) };
        approvals.push(stored.result.decision === "approved"
          ? { ...identity, result: structuredClone(stored.result), basis: { kind: "new" } }
          : { ...identity, result: structuredClone(stored.result), basis: { kind: "denied" } });
      }
    }
    return approvals;
  }
}
