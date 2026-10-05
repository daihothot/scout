import type { AuthorizationRecord, RequestSourceRegisteredRecord, RequestSourceExpiredRecord } from "../../record/authorization-record.js";
import type { RequestSourceType, ScoutRequestSource } from "../types.js";
import { RequestSourceEvents } from "../request-source-events.js";

/** Projects fully decoded registrations into runtime requests, then restores expiry. */
export class RequestSourceProjector {
  constructor(private readonly contracts: ReadonlyMap<string, RequestSourceType<ScoutRequestSource>>) {}
  project(records: readonly AuthorizationRecord[], workflowId: string): ScoutRequestSource[] {
    const requests = new Map<string, ScoutRequestSource>();
    const identities = new Set<string>();
    for (const record of records) {
      if (record.key.routeKey === RequestSourceEvents.authorizationRequestSource.registered.routeKey) {
        const decoded = (record.payload as RequestSourceRegisteredRecord).source;
        if (decoded.workflowId !== workflowId) throw new Error("Invalid request registration Workflow.");
        if (requests.has(decoded.sourceId)) throw new Error(`Request already registered: ${decoded.sourceId}`);
        const identity = JSON.stringify([decoded.workflowId, decoded.type, decoded.sourceKey]);
        if (identities.has(identity)) throw new Error(`Request source identity already registered: ${decoded.sourceKey}`);
        identities.add(identity);
        requests.set(decoded.sourceId, this.contracts.get(decoded.type)!.project(decoded));
      } else if (record.key.routeKey === RequestSourceEvents.authorizationRequestSource.expired.routeKey) {
        const { sourceId, reason, workflowId: owner } = record.payload as RequestSourceExpiredRecord;
        if (owner !== workflowId) throw new Error("Invalid request expiry Workflow.");
        const request = requests.get(sourceId);
        if (!request || request.state.status !== "active") throw new Error(`Request is not active: ${sourceId}`);
        requests.set(sourceId, { ...request, state: { status: "expired", expiredAt: record.occurredAt, reason } });
      }
    }
    return [...requests.values()];
  }
}
