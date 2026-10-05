import type { ScoutRequestSourceRecord } from "../../record/authorization-record.js";
import type { ScoutRequest } from "../../types.js";
import type { RequestSourceType, ScoutRequestSource } from "../types.js";
import type { RequestSourceHub } from "../request-source-hub.js";

/** Stateless matching reads live sources; it never approves or spends their allowance. */
export class RequestSourceMatching {
  constructor(private readonly sources: RequestSourceHub) {}

  match<TSource extends ScoutRequestSource, TRecord extends ScoutRequestSourceRecord, TRequest extends ScoutRequest>(
    type: RequestSourceType<TSource, TRecord, TRequest>, request: TRequest,
  ): { source: TSource; grant: TSource["allowedGrants"][number] }[] {
    const candidates: { source: TSource; grant: TSource["allowedGrants"][number] }[] = [];
    for (const source of this.sources.ofType(type)) {
      if (source.state.status !== "active" || source.workflowId !== request.workflowId) continue;
      const grant = type.match(source, request);
      if (grant) candidates.push({ source, grant });
    }
    return candidates;
  }
}
