import type { ScoutEvent } from "../../../../core/events/index.js";
import { ExecutionEvents, type ExecutionSelectionIdentity } from "../../../../execution/index.js";

/** Confirmed execution state shared by live observation and Journal replay. */
export interface BaseDomainExecutionState {
  selection: ExecutionSelectionIdentity;
  state: "identified" | "launched" | "stopped";
  appId?: string;
  correlationId: string;
  occurredAt: string;
}

/** Applies only confirmed execution facts; a failed command does not imply shutdown. */
export function projectBaseExecutionEvent(
  previous: BaseDomainExecutionState | undefined,
  event: ScoutEvent,
): BaseDomainExecutionState | undefined {
  if (ExecutionEvents.execution.identifyCompleted.is(event)) {
    const { result, correlationId } = event.payload;
    if (!result.ok) return result.requiresIdentify ? undefined : previous;
    if (previous && sameExecutionSelection(previous.selection, result.selection)) return previous;
    return {
      selection: structuredClone(result.selection),
      state: "identified",
      correlationId,
      occurredAt: event.occurredAt,
    };
  }
  if (ExecutionEvents.execution.launchCompleted.is(event)
    || ExecutionEvents.execution.shutdownCompleted.is(event)) {
    const { result, request, correlationId } = event.payload;
    if (!result.ok) return result.requiresIdentify ? undefined : previous;
    const appId = request.appId?.trim();
    const shuttingDown = ExecutionEvents.execution.shutdownCompleted.is(event);
    if (shuttingDown && previous?.state === "launched" && (
      !sameExecutionSelection(previous.selection, result.selection)
      || previous.appId !== appId
    )) return previous;
    return {
      selection: structuredClone(result.selection),
      state: shuttingDown ? "stopped" : "launched",
      ...(appId !== undefined ? { appId } : {}),
      correlationId,
      occurredAt: event.occurredAt,
    };
  }
  return previous;
}

export function sameExecutionSelection(left: ExecutionSelectionIdentity, right: ExecutionSelectionIdentity): boolean {
  return left.transport === right.transport
    && left.platform.type === right.platform.type
    && left.platform.version === right.platform.version;
}
