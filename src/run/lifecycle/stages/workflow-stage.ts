import type { Workflow } from "../../../core/workflow/workflow.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../../lifecycle/run-stage.js";

/** Installs and boots the Workflow service for the active RunScope. */
export class WorkflowStage implements RunStage {
  readonly id = "workflow";
  private started = false;
  private installed = false;

  constructor(private readonly workflow: Workflow) {}

  async start(): Promise<void> {
    if (this.started) return;
    if (this.installed) throw new Error("Workflow startup cleanup is pending; stop the installed service before retrying.");
    const scope = currentRunScope();
    scope.setWorkflow(this.workflow);
    // An entered service remains owned until cleanup succeeds, including a
    // startup failure whose journal could not be closed.
    this.installed = true;
    await this.workflow.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.installed) return;
    const scope = currentRunScope();
    if (scope.domainRegistry.list().length > 0) {
      throw new Error("Cannot release Workflow while unreleased Domains remain registered; its Root lock is retained.");
    }
    this.started = false;
    await this.workflow.stop();
    scope.clearWorkflow(this.workflow);
    this.installed = false;
  }
}
