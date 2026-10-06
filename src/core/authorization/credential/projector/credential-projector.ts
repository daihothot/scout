import type { AuthorizationRecord, RequestSourceRegisteredRecord, RequestSourceExpiredRecord, ApprovalRecord, CredentialUseRecord } from "../../record/authorization-record.js";
import type { RequestSourceType, ScoutRequestSource } from "../../request-source/types.js";
import { RequestSourceEvents } from "../../request-source/request-source-events.js";
import { ApprovalEvents } from "../../approval/approval-events.js";
import { CredentialEvents } from "../credential-events.js";
import type { Credential, CredentialUse } from "../types.js";

/** Projects issuance from new approvals and validates each separately recorded use. */
export class CredentialProjector {
  constructor(private readonly contracts: ReadonlyMap<string, RequestSourceType<ScoutRequestSource>>) {}
  project(records: readonly AuthorizationRecord[], workflowId: string): { credentials: Credential[]; usages: CredentialUse[] } {
    const requests = new Map<string, ScoutRequestSource>();
    const active = new Set<string>();
    const credentials = new Map<string, Credential>();
    const usages: CredentialUse[] = [];
    for (const record of records) {
      if (record.key.routeKey === RequestSourceEvents.authorizationRequestSource.registered.routeKey) {
        const { source } = record.payload as RequestSourceRegisteredRecord;
        const request = this.contracts.get(source.type)!.project(source);
        requests.set(request.sourceId, request);
        active.add(request.sourceId);
      } else if (record.key.routeKey === RequestSourceEvents.authorizationRequestSource.expired.routeKey) {
        active.delete((record.payload as RequestSourceExpiredRecord).sourceId);
      } else if (record.key.routeKey === ApprovalEvents.authorizationApproval.submitted.routeKey) {
        const approval = record.payload as ApprovalRecord;
        if (approval.result.decision !== "approved") continue;
        const request = requests.get(approval.sourceId)!;
        const grant = this.contracts.get(request.type)!.resolveGrant(request, approval.result);
        if (!grant) throw new Error("Invalid persisted credential grant.");
        credentials.set(approval.approvalId, {
          credentialId: approval.approvalId, sourceId: approval.sourceId, sourceType: approval.sourceType,
          workflowId: approval.workflowId, issuedAt: approval.submittedAt,
          scope: grant.scope, target: grant.target,
        });
      } else if (record.key.routeKey === CredentialEvents.authorizationCredential.used.routeKey) {
        const use = record.payload as CredentialUseRecord;
        const credential = credentials.get(use.credentialId);
        const request = requests.get(use.sourceId);
        if (!credential || !request || !active.has(request.sourceId)
          || use.workflowId !== workflowId || request.workflowId !== workflowId
          || credential.workflowId !== workflowId || credential.sourceType !== request.type
          || !this.contracts.get(request.type)!.resolveGrant(request, credential)) throw new Error("Invalid persisted credential reference.");
        usages.push({ credentialId: use.credentialId, approvalId: use.approvalId, sourceId: use.sourceId,
          workflowId: use.workflowId, usedAt: use.usedAt, consumer: structuredClone(use.consumer) });
      }
    }
    return { credentials: [...credentials.values()], usages };
  }
}
