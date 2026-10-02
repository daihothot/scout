import type { RecordEvent } from "../../../../core/record/index.js";
import type { ExecutionCommandCompletedEvent } from "../../../../execution/execution-events.js";
import type { BaseDomainAgentToolCallObservedEvent } from "../base-domain-events.js";

/** Decoded Base file contracts, discriminated by their persisted event route. */
export type BaseDomainRecord =
  | RecordEvent<ExecutionCommandCompletedEvent, "system.execution.identify_completed">
  | RecordEvent<ExecutionCommandCompletedEvent, "system.execution.launch_completed">
  | RecordEvent<ExecutionCommandCompletedEvent, "system.execution.shutdown_completed">
  | RecordEvent<BaseDomainAgentToolCallObservedEvent, "domain.base.agent_tool_call.observed">;

export function decodeBaseDomainRecords(records: readonly RecordEvent[]): BaseDomainRecord[] {
  return records.map((record) => {
    const invalid = (field: string): never => { throw new Error(`Invalid Base record ${record.seq} (${record.key.routeKey}): ${field}`); };
    const object = (value: unknown, field: string): Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
      return value as Record<string, unknown>;
    };
    const strings = (value: Record<string, unknown>, fields: readonly string[]): void => {
      for (const field of fields) if (typeof value[field] !== "string") invalid(field);
    };
    const selection = (value: unknown): void => {
      const identity = object(value, "selection");
      strings(identity, ["transport"]);
      strings(object(identity.platform, "platform"), ["type", "version"]);
    };
    const payload = object(record.payload, "payload");
    switch (record.key.routeKey) {
      case "system.execution.identify_completed":
      case "system.execution.launch_completed":
      case "system.execution.shutdown_completed": {
        strings(payload, ["correlationId"]);
        const request = object(payload.request, "request");
        for (const field of ["transport", "platform", "appId"]) {
          if (request[field] !== undefined && typeof request[field] !== "string") invalid(`request.${field}`);
        }
        if (request.identity !== undefined) selection(request.identity);
        if (request.parameters !== undefined) {
          const parameters = object(request.parameters, "request.parameters");
          if (Object.values(parameters).some((value) => typeof value !== "string")) invalid("request.parameters");
        }
        const result = object(payload.result, "result");
        if (result.ok === true) selection(result.selection);
        else if (result.ok === false) {
          strings(result, ["code", "message"]);
          if (result.requiresIdentify !== undefined && result.requiresIdentify !== true) invalid("result.requiresIdentify");
        } else invalid("result.ok");
        break;
      }
      case "domain.base.agent_tool_call.observed": {
        strings(payload, ["callId", "agentId", "role", "phase", "namespace", "tool", "startedAt", "completedAt"]);
        if (payload.threadId !== undefined && typeof payload.threadId !== "string") invalid("threadId");
        const response = object(payload.response, "response");
        if (typeof response.success !== "boolean") invalid("response.success");
        const items = response.contentItems;
        if (!Array.isArray(items)) return invalid("response.contentItems");
        for (const item of items) {
          const content = object(item, "response.contentItems");
          if (content.type === "inputText") strings(content, ["text"]);
          else invalid("response.contentItems.type");
        }
        break;
      }
      default: invalid("unsupported event route");
    }
    // Only this file boundary turns external JSON into a trusted record contract.
    return structuredClone(record) as BaseDomainRecord;
  });
}
