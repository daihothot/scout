import type { ScoutEvent } from "../../events/index.js";
import { authorizationJournalPaths } from "../../io/index.js";
import { RecordableObject, type RecordEvent } from "../../record/index.js";
import { currentRunScope } from "../../../run/run-scope.js";
import { RequestEvents } from "../request/request-events.js";
import { ApprovalEvents } from "../approval/approval-events.js";
import { CredentialEvents } from "../credential/credential-events.js";
import type { RequestType, ScoutRequest } from "../request/types.js";
import { decodeAuthorizationRecords, type AuthorizationRecord } from "./authorization-record.js";

/** Owns recording and decoding only; Authorization owns all runtime decisions. */
export class AuthorizationRecordObject extends RecordableObject<AuthorizationRecord> {
  readonly eventTypes = [
    RequestEvents.authorizationRequest.registered, RequestEvents.authorizationRequest.expired,
    ApprovalEvents.authorizationApproval.submitted, CredentialEvents.authorizationCredential.used,
  ];
  protected override readonly requiredEventWrites = true;

  constructor(private readonly contracts: ReadonlyMap<string, RequestType<ScoutRequest>>) { super("Authorization"); }

  protected location(journalRoot: string) {
    return { journalId: `${currentRunScope().runId}:authorization`, ...authorizationJournalPaths(journalRoot) };
  }

  protected override encode(event: ScoutEvent): ScoutEvent {
    if (RequestEvents.authorizationRequest.registered.is(event)) {
      const request = event.payload.request;
      const contract = this.contracts.get(request.type)!;
      return { ...event, payload: { request: contract.encode(request) } };
    }
    // Approval and use events have value-only payloads, independent of their runtime objects.
    return { ...event, payload: structuredClone(event.payload) };
  }

  protected decode(records: readonly RecordEvent[]): AuthorizationRecord[] {
    return decodeAuthorizationRecords(records, this.contracts);
  }
}
