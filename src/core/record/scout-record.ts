import type { EventType } from "../events/index.js";
import { AgentEvents } from "../../agent/events/index.js";
import { RunEvents } from "../../run/events/index.js";
import { SystemEvents } from "../../system/events/index.js";
import { WorkflowEvents } from "../workflow/workflow-events.js";
import type { RecordEvent } from "./recordable-object.js";

type Payload<T extends EventType> = T extends EventType<infer TPayload> ? TPayload : never;
interface ScoutRecordPayloads {
  "system.run.created": Payload<typeof RunEvents.run.created>;
  "system.runtime.attached": Payload<typeof RunEvents.runtime.attached>;
  "system.runtime.detached": Payload<typeof RunEvents.runtime.detached>;
  "system.runtime.interrupted": Payload<typeof RunEvents.runtime.interrupted>;
  "system.workflow.initialized": Payload<typeof WorkflowEvents.workflow.initialized>;
  "system.workflow.advanced": Payload<typeof WorkflowEvents.workflow.advanced>;
  "system.workflow.completed": Payload<typeof WorkflowEvents.workflow.completed>;
  "system.interaction.user_message_submitted": Payload<typeof SystemEvents.interaction.userMessageSubmitted>;
  "agent.coordinator.message_produced": Payload<typeof AgentEvents.coordinator.messageProduced>;
  "agent.thread.started": Payload<typeof AgentEvents.thread.started>;
  "agent.thread.resumed": Payload<typeof AgentEvents.thread.resumed>;
  "agent.thread.restarted": Payload<typeof AgentEvents.thread.restarted>;
  "agent.thread.closed": Payload<typeof AgentEvents.thread.closed>;
  "agent.message.queued": Payload<typeof AgentEvents.message.queued>;
  "agent.message.consumed": Payload<typeof AgentEvents.message.consumed>;
  "agent.turn.started": Payload<typeof AgentEvents.turn.started>;
  "agent.turn.completed": Payload<typeof AgentEvents.turn.completed>;
  "agent.turn.interrupted": Payload<typeof AgentEvents.turn.interrupted>;
  "agent.task.assigned": Payload<typeof AgentEvents.task.assigned>;
  "agent.task.step_started": Payload<typeof AgentEvents.task.stepStarted>;
  "agent.task.step_completed": Payload<typeof AgentEvents.task.stepCompleted>;
  "agent.task.step_interrupted": Payload<typeof AgentEvents.task.stepInterrupted>;
  "agent.task.disposition_recorded": Payload<typeof AgentEvents.task.dispositionRecorded>;
  "agent.task.outcome_submitted": Payload<typeof AgentEvents.task.outcomeSubmitted>;
  "agent.task.released": Payload<typeof AgentEvents.task.released>;
  "agent.task.failed": Payload<typeof AgentEvents.task.failed>;
  "agent.task.stopped": Payload<typeof AgentEvents.task.stopped>;
  "agent.task.done": Payload<typeof AgentEvents.task.done>;
  "agent.step.started": Payload<typeof AgentEvents.step.started>;
  "agent.step.completed": Payload<typeof AgentEvents.step.completed>;
  "agent.step.interrupted": Payload<typeof AgentEvents.step.interrupted>;
  "agent.step.failed": Payload<typeof AgentEvents.step.failed>;
  "agent.step.plan_updated": Payload<typeof AgentEvents.step.planUpdated>;
  "agent.step.tool_call_referenced": Payload<typeof AgentEvents.step.toolCallReferenced>;
  "agent.step.human_input_referenced": Payload<typeof AgentEvents.step.humanInputReferenced>;
  "agent.tool_call.observed": Payload<typeof AgentEvents.toolCall.observed>;
  "agent.human_input.requested": Payload<typeof AgentEvents.humanInput.requested>;
  "agent.human_input.responded": Payload<typeof AgentEvents.humanInput.responded>;
}

/** Trusted decoded records; the persisted route discriminates the payload contract. */
export type ScoutRecord = {
  [TRoute in keyof ScoutRecordPayloads]: RecordEvent<ScoutRecordPayloads[TRoute], TRoute>
}[keyof ScoutRecordPayloads];

/** File decoding only. Causal ordering and runtime aggregation are projector responsibilities. */
export function decodeScoutRecords(records: readonly RecordEvent[]): ScoutRecord[] {
  return records.map((record) => {
    const invalid = (field: string): never => { throw new Error(`Invalid Scout record ${record.seq} (${record.key.routeKey}): ${field}`); };
    const object = (value: unknown, field: string): Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
      return value as Record<string, unknown>;
    };
    const strings = (value: Record<string, unknown>, fields: readonly string[], optional: readonly string[] = []): void => {
      for (const field of fields) if (typeof value[field] !== "string") invalid(field);
      for (const field of optional) if (value[field] !== undefined && typeof value[field] !== "string") invalid(field);
    };
    const array = (value: unknown, field: string): unknown[] => {
      if (!Array.isArray(value)) invalid(field);
      return value as unknown[];
    };
    const stringArray = (value: unknown, field: string): void => {
      if (array(value, field).some((item) => typeof item !== "string")) invalid(field);
    };
    const oneOf = (value: unknown, values: readonly string[], field: string): void => {
      if (typeof value !== "string" || !values.includes(value)) invalid(field);
    };
    const plan = (value: unknown): void => {
      const data = object(value, "plan");
      strings(data, [], ["explanation"]);
      for (const step of array(data.steps, "plan.steps")) strings(object(step, "plan step"), ["step", "status"]);
    };
    const message = (value: unknown): void => {
      const data = object(value, "message");
      strings(data, ["messageId", "agentId", "body", "queuedAt"], ["taskId"]);
      if (data.deliveryMode !== undefined && data.deliveryMode !== "steer" && data.deliveryMode !== "queued") invalid("deliveryMode");
    };
    const disposition = (value: unknown): void => {
      const data = object(value, "disposition");
      strings(data, ["stepId", "turnId", "timestamp"]);
      switch (data.kind) {
        case "handoff_submitted": strings(data, ["callId", "outcome"]); break;
        case "waiting_for_human": strings(data, ["callId", "requestId", "request"]); break;
        case "protocol_violation":
          strings(data, ["reason"]);
          if (data.callId !== null) invalid("disposition.callId");
          break;
        default: invalid("disposition.kind");
      }
    };
    const task = (value: unknown): void => {
      const data = object(value, "task");
      strings(data, ["taskId", "agentId", "role", "phase", "description", "initialPrompt", "createdAt", "updatedAt"], ["startedAt", "finishedAt", "error"]);
      if (data.type !== "local_agent" || typeof data.isBackgrounded !== "boolean"
        || typeof data.taskSequence !== "number" || !Number.isSafeInteger(data.taskSequence) || data.taskSequence < 1) invalid("task lifecycle");
      oneOf(data.status, ["queued", "running", "done", "failed", "stopped"], "task.status");
      stringArray(data.stepIds, "task.stepIds");
      for (const value of array(data.dispositions, "task.dispositions")) disposition(value);
      if (data.protocolRepairAttempts !== undefined && (typeof data.protocolRepairAttempts !== "number"
        || !Number.isSafeInteger(data.protocolRepairAttempts) || data.protocolRepairAttempts < 0)) invalid("task.protocolRepairAttempts");
      if (data.usage !== undefined) {
        const usage = object(data.usage, "task.usage");
        for (const field of ["totalTokens", "toolUses", "durationMs"]) {
          if (usage[field] !== undefined && (typeof usage[field] !== "number" || !Number.isFinite(usage[field]))) invalid(`task.usage.${field}`);
        }
      }
    };
    const thread = (value: unknown): void => {
      const data = object(value, "thread");
      strings(data, ["agentId", "role", "contextBundleId", "threadId", "createdAt"]);
      stringArray(data.phases, "thread.phases");
      object(data.startInput, "thread.startInput");
      if (data.status === "closed") strings(data, ["closedAt", "closeReason"]);
      else if (data.status !== "active") invalid("thread.status");
    };
    const graph = (value: unknown): void => {
      const data = object(value, "GraphData");
      strings(data, ["domain", "workflowProfile", "currentPhase"]);
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(data.domain as string)) invalid("GraphData.domain");
      for (const value of array(data.phases, "GraphData.phases")) {
        const phase = object(value, "GraphData phase");
        strings(phase, ["name"]);
        stringArray(phase.roles, "GraphData phase.roles");
        const edges = object(phase.edges, "GraphData phase.edges");
        for (const field of ["completed", "error"]) if (edges[field] !== null && typeof edges[field] !== "string") invalid(`GraphData edge.${field}`);
      }
      for (const value of array(data.roles, "GraphData.roles")) {
        const role = object(value, "GraphData role");
        strings(role, ["name"]);
        stringArray(role.phases, "GraphData role.phases");
      }
    };
    const payload = object(record.payload, "payload");
    switch (record.key.routeKey) {
      case "system.run.created": strings(payload, ["runId", "scoutRoot", "createdAt"]); break;
      case "system.runtime.attached":
        strings(payload, ["attachedAt"]);
        if ((payload.mode !== "start" && payload.mode !== "resume") || typeof payload.processId !== "number") invalid("runtime attachment");
        break;
      case "system.runtime.detached": strings(payload, ["reason", "detachedAt"]); break;
      case "system.runtime.interrupted": strings(payload, ["reason", "interruptedAt"]); break;
      case "system.workflow.initialized": strings(payload, ["initializedAt"]); graph(payload.state); break;
      case "system.workflow.advanced":
        strings(payload, ["previousPhase", "advancedAt"]);
        if ((payload.outcome !== "completed" && payload.outcome !== "error") || typeof payload.cycleCompleted !== "boolean") invalid("Graph advance");
        graph(payload.state);
        break;
      case "system.workflow.completed": strings(payload, ["completedAt"]); break;
      case "system.interaction.user_message_submitted":
        strings(payload, ["messageId", "text", "submittedAt", "attachment"], ["source"]);
        break;
      case "agent.coordinator.message_produced": strings(payload, ["messageId", "agentId", "text", "createdAt"], ["threadId", "turnId"]); break;
      case "agent.thread.started":
      case "agent.thread.closed": thread(payload); break;
      case "agent.thread.resumed":
        strings(payload, ["agentId", "role", "threadId", "resumedAt"]);
        object(payload.resumeInput, "resumeInput");
        break;
      case "agent.thread.restarted":
        strings(payload, ["previousThreadId", "reason", "restartedAt"]);
        thread(payload.newThread);
        break;
      case "agent.message.queued": message(payload); break;
      case "agent.message.consumed":
        strings(payload, ["messageId", "agentId", "stepId", "consumedAt"], ["taskId", "turnId"]);
        if (payload.deliveryMode !== undefined && payload.deliveryMode !== "steer" && payload.deliveryMode !== "queued") invalid("deliveryMode");
        break;
      case "agent.turn.started": strings(payload, ["invocationId", "agentId", "role", "threadId", "prompt", "startedAt"], ["taskId"]); break;
      case "agent.turn.interrupted": strings(payload, ["invocationId", "agentId", "role", "threadId", "reason", "interruptedAt"], ["taskId"]); break;
      case "agent.turn.completed": {
        strings(payload, [], ["taskId"]);
        const turn = object(payload.turn, "turn");
        strings(turn, ["invocationId", "agentId", "role", "threadId", "startedAt", "finishedAt"], ["turnId", "outputContract", "error"]);
        oneOf(turn.status, ["completed", "failed", "interrupted"], "turn.status");
        break;
      }
      case "agent.task.assigned":
      case "agent.task.step_started":
      case "agent.task.step_completed":
      case "agent.task.step_interrupted":
      case "agent.task.released":
      case "agent.task.failed":
      case "agent.task.stopped": task(payload); break;
      case "agent.task.done": task(payload); break;
      case "agent.task.disposition_recorded": task(payload.task); disposition(payload.disposition); break;
      case "agent.task.outcome_submitted": strings(payload, ["stepId", "outcome", "submittedAt"], ["turnId", "callId"]); task(payload.task); break;
      case "agent.step.started":
      case "agent.step.completed":
      case "agent.step.interrupted":
      case "agent.step.failed":
      case "agent.step.tool_call_referenced":
      case "agent.step.human_input_referenced":
        strings(payload, ["stepId", "agentId", "prompt", "startedAt", "updatedAt"], ["taskId", "turnId", "finishedAt", "finalResponse", "error"]);
        oneOf(payload.status, ["running", "completed", "interrupted", "failed"], "Step status");
        stringArray(payload.toolCallIds, "Step.toolCallIds");
        for (const value of array(payload.humanInputReferences, "Step.humanInputReferences")) {
          const reference = object(value, "Human Input reference");
          strings(reference, ["requestId"]);
          oneOf(reference.kind, ["request_produced", "request_consumed", "response_produced", "response_consumed"], "Human Input reference.kind");
        }
        if (payload.plan !== undefined) plan(payload.plan);
        if (payload.durationMs !== undefined && (typeof payload.durationMs !== "number" || !Number.isFinite(payload.durationMs))) invalid("Step.durationMs");
        break;
      case "agent.step.plan_updated": strings(payload, ["stepId", "agentId", "turnId", "updatedAt"], ["taskId"]); plan(payload.plan); break;
      case "agent.tool_call.observed":
        strings(payload, ["toolCallId", "agentId", "stepId", "threadId", "turnId", "itemId", "tool", "status", "observedAt"], ["taskId", "server", "finishedAt"]);
        if ((payload.kind !== "dynamic" && payload.kind !== "mcp") || typeof payload.sourceSeq !== "number"
          || !Number.isSafeInteger(payload.sourceSeq) || payload.sourceSeq < 0) invalid("Tool Call identity");
        if (payload.namespace !== undefined && payload.namespace !== null && typeof payload.namespace !== "string") invalid("Tool Call namespace");
        if (payload.success !== undefined && payload.success !== null && typeof payload.success !== "boolean") invalid("Tool Call success");
        if (payload.contentItems !== undefined && payload.contentItems !== null) array(payload.contentItems, "Tool Call contentItems");
        break;
      case "agent.human_input.requested":
      case "agent.human_input.responded":
        strings(payload, ["requestId", "stepId", "taskId", "agentId", "body", record.key.routeKey.endsWith("requested") ? "requestedAt" : "respondedAt"]);
        message(payload.message);
        break;
      default: invalid("unsupported event route");
    }
    return structuredClone(record) as ScoutRecord;
  });
}
