import { currentRunScope } from "../../../run/run-scope.js";
import { SystemEvents } from "../../../system/events/index.js";

/** Reports lifecycle failures and nonfatal finalization errors without changing execution facts. */
export async function reportWorkflowTransitionError(direction: string, error: unknown): Promise<void> {
  const scope = currentRunScope();
  const errors: string[] = [];
  const visited = new Set<unknown>();
  const describe = (failure: unknown): void => {
    if (visited.has(failure)) return;
    visited.add(failure);
    errors.push(failure instanceof Error ? failure.stack ?? failure.message : String(failure));
    if (failure instanceof AggregateError) for (const nested of failure.errors) describe(nested);
    if (failure instanceof Error && failure.cause !== undefined) describe(failure.cause);
  };
  describe(error);
  const data = { direction, errors };
  try {
    scope.logger.error({ module: "workflow.transition", event: "workflow_transition_failed", message: `Workflow transition ${direction} failed.`, data });
  } catch { /* Error disclosure must remain available if runtime logging fails. */ }
  try {
    await scope.eventBus.publishAndWait(SystemEvents.interaction.disclosureRequested, {
      level: "error", source: "workflow.transition", message: `Workflow transition ${direction} failed.`, data,
    });
  } catch { /* A diagnostic observer cannot change the committed execution facts. */ }
}
