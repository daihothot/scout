import type { ScoutWorkflowParticipant } from "../../src/core/workflow/workflow-participant.js";
import { projectAgentWorkflow } from "../../src/agent/orchestration/projector/agent-workflow-projector.js";
import { currentRunScope } from "../../src/run/run-scope.js";
import { resolveSynthesisRole } from "../../src/core/workflow/graph-data.js";

/** Stateless lifecycle fixture for tests that exercise a backend rather than domain recovery. */
export const testWorkflowParticipant: ScoutWorkflowParticipant = {
  create() {}, restore() {}, run() {}, close() {}, abort() {}, clearWorkflow() {},
};

export function projectCurrentAgentWorkflow() {
  const workflow = currentRunScope().workflow;
  return workflow.snapshot() ? projectAgentWorkflow(workflow.readEvents(), resolveSynthesisRole(workflow.graph.snapshot()).name) : undefined;
}
