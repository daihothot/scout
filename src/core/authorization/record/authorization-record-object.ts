import type { ScoutEvent } from "../../events/index.js";
import { authorizationJournalPaths } from "../../io/index.js";
import { RecordableObject, type RecordEvent } from "../../record/index.js";
import { currentRunScope } from "../../../run/run-scope.js";
import { RequestSourceEvents } from "../request-source/request-source-events.js";
import { ApprovalEvents } from "../approval/approval-events.js";
import { CredentialEvents } from "../credential/credential-events.js";
import type { RequestSourceType, ScoutRequestSource } from "../request-source/types.js";
import { decodeAuthorizationRecords, type AuthorizationRecord } from "./authorization-record.js";

/** Owns recording and decoding only; Authorization owns all runtime decisions. */
export class AuthorizationRecordObject extends RecordableObject<AuthorizationRecord> {
  readonly eventTypes = [
    RequestSourceEvents.authorizationRequestSource.registered, RequestSourceEvents.authorizationRequestSource.expired,
    ApprovalEvents.authorizationApproval.submitted, CredentialEvents.authorizationCredential.used,
  ];
  protected override readonly requiredEventWrites = true;

  constructor(private readonly contracts: ReadonlyMap<string, RequestSourceType<ScoutRequestSource>>) { super("Authorization"); }

  protected location(journalRoot: string) {
    return { journalId: `${currentRunScope().runId}:authorization`, ...authorizationJournalPaths(journalRoot) };
  }

  protected override encode(event: ScoutEvent): ScoutEvent {
    if (RequestSourceEvents.authorizationRequestSource.registered.is(event)) {
      const request = event.payload.source;
      const contract = this.contracts.get(request.type)!;
      return { ...event, payload: { source: contract.encode(request) } };
    }
    // Approval and use events have value-only payloads, independent of their runtime objects.
    return { ...event, payload: structuredClone(event.payload) };
  }

  protected decode(records: readonly RecordEvent[]): AuthorizationRecord[] {
    return decodeAuthorizationRecords(records, this.contracts);
  }
}
