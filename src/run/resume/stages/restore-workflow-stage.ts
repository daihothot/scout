import { statSync } from "node:fs";
import type { Workflow, WorkflowResumeInput } from "../../../core/workflow/workflow.js";
import { ScoutBenchmarks } from "../../../core/benchmarks/scout-benchmarks.js";
import { scoutJournalPaths } from "../../../core/path.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../../lifecycle/run-stage.js";

/** Installs Workflow, then restores only the preflight-selected execution. */
export class RestoreWorkflowStage implements RunStage {
  readonly id = "workflow";
  private installed = false;
  private started = false;

  constructor(
    private readonly workflow: Workflow,
    private readonly recovery?: WorkflowResumeInput,
    private readonly missingWorkflowId?: string,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    if (this.installed) throw new Error("Workflow startup cleanup is pending; stop the installed service before retrying.");
    const scope = currentRunScope();
    scope.setWorkflow(this.workflow);
    this.installed = true;
    await this.workflow.start();
    if (this.recovery) {
      this.workflow.restore(this.recovery);
    } else if (this.missingWorkflowId) {
      const benchmarks = new ScoutBenchmarks(this.workflow.benchmarks);
      if (benchmarks.read()?.currentWorkflow !== this.missingWorkflowId) {
        throw new Error("Workflow benchmark selection changed before its runtime lock was acquired; retry resume.");
      }
      const selected = benchmarks.resolve("currentWorkflow");
      if (selected) {
        try {
          statSync(scoutJournalPaths(selected.journalRoot).path);
          throw new Error("Workflow missing journal reappeared before its runtime lock was acquired; retry resume.");
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        }
      }
    }
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
