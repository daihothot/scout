import type { AuthorizationRecord, RequestRegisteredRecord, RequestExpiredRecord } from "../../record/authorization-record.js";
import type { RequestType, ScoutRequest } from "../types.js";
import { RequestEvents } from "../request-events.js";

/** Projects fully decoded registrations into runtime requests, then restores expiry. */
export class RequestProjector {
  constructor(private readonly contracts: ReadonlyMap<string, RequestType<ScoutRequest>>) {}
  project(records: readonly AuthorizationRecord[], workflowId: string): ScoutRequest[] {
    const requests = new Map<string, ScoutRequest>();
    for (const record of records) {
      if (record.key.routeKey === RequestEvents.authorizationRequest.registered.routeKey) {
        const decoded = (record.payload as RequestRegisteredRecord).request;
        if (decoded.workflowId !== workflowId) throw new Error("Invalid request registration Workflow.");
        if (requests.has(decoded.requestId)) throw new Error(`Request already registered: ${decoded.requestId}`);
        requests.set(decoded.requestId, this.contracts.get(decoded.type)!.project(decoded));
      } else if (record.key.routeKey === RequestEvents.authorizationRequest.expired.routeKey) {
        const { requestId, reason, workflowId: owner } = record.payload as RequestExpiredRecord;
        if (owner !== workflowId) throw new Error("Invalid request expiry Workflow.");
        const request = requests.get(requestId);
        if (!request || request.state.status !== "active") throw new Error(`Request is not active: ${requestId}`);
        requests.set(requestId, { ...request, state: { status: "expired", expiredAt: record.occurredAt, reason } });
      }
    }
    return [...requests.values()];
  }
}
