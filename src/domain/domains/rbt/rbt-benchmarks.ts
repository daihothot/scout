import type { UnsubscribeEventHandler } from "../../../core/events/index.js";
import type { BenchmarkWorkflowReference } from "../../../core/benchmarks/index.js";
import { currentRunScope } from "../../../run/run-scope.js";
import { SystemEvents } from "../../../system/events/index.js";
import { DomainBenchmarks } from "../../core/benchmarks/index.js";
import { ScoutDomainId } from "../../types.js";
import { RbtEvents } from "./rbt-events.js";

/** Nodes exist only after their corresponding fact has occurred. */
export interface RbtBenchmarkEntry {
  history: {
    lastRun?: BenchmarkWorkflowReference;
    lastExecutionSuccess?: BenchmarkWorkflowReference;
    lastExecutionPack?: BenchmarkWorkflowReference;
    lastReviewerPack?: BenchmarkWorkflowReference;
    lastReviewSuccess?: BenchmarkWorkflowReference;
  };
  statistics?: { passedPlatforms: string[] };
}

/** RBT fact-to-permalink rules. No artifact discovery, replay, or reuse decision belongs here. */
export class RbtBenchmarks extends DomainBenchmarks {
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];

  constructor() { super(ScoutDomainId.Rbt); }

  start(): void {
    if (this.unsubscribers.length) return;
    const scope = currentRunScope();
    for (const target of [RbtEvents.history.ready, RbtEvents.artifact]) {
      this.unsubscribers.push(scope.eventBus.subscribe(target, (event) => {
        try {
          if (RbtEvents.history.ready.is(event)) {
            const fact = event.payload;
            const workflow = scope.workflow.snapshot();
            if (!workflow) throw new Error("RBT Benchmarks require an active Workflow.");
            const reference = { workflowId: workflow.workflowId };
            const path = ["bddCatalog", fact.bddId, fact.targetVersion, "history"];
            this.submit([
              { path: [...path, "lastRun"], value: reference },
              ...(fact.status === "completed" ? [{ path: [...path, "lastExecutionSuccess"], value: reference }] : []),
            ]);
          } else if (RbtEvents.artifact.executionPackSubmitted.is(event)) {
            const fact = event.payload;
            this.submit([{ path: ["bddCatalog", fact.bddId, fact.targetVersion, "history", "lastExecutionPack"], value: { workflowId: fact.pack.workflowId } }]);
          } else if (RbtEvents.artifact.reviewSubmitted.is(event)) {
            const fact = event.payload;
            const path = ["bddCatalog", fact.bddId, fact.targetVersion];
            const reference = { workflowId: fact.pack.workflowId };
            if (fact.pack.result !== "pass") {
              this.submit([{ path: [...path, "history", "lastReviewerPack"], value: reference }]);
              return;
            }
            const previous = scope.workflow.benchmarks.read(this.domainId, [...path, "statistics", "passedPlatforms"]);
            const platforms: string[] = [];
            if (previous !== undefined) {
              if (!Array.isArray(previous)) throw new Error("RBT passedPlatforms must be an array of platform ids.");
              for (const platform of previous) {
                if (typeof platform !== "string" || !platform.trim()) throw new Error("Invalid RBT passedPlatforms entry.");
                platforms.push(platform);
              }
            }
            this.submit([
              { path: [...path, "history", "lastReviewerPack"], value: reference },
              { path: [...path, "history", "lastReviewSuccess"], value: reference },
              { path: [...path, "statistics", "passedPlatforms"], value: [...new Set([...platforms, fact.pack.execution.platform.type])] },
            ]);
          }
        } catch (error) {
          const message = `RBT Benchmarks were not updated for ${event.key.routeKey}: ${error instanceof Error ? error.message : String(error)}`;
          scope.logger.warn({ module: "domain.rbt.benchmarks", event: "rbt_benchmarks_write_failed", message });
          scope.eventBus.publish(SystemEvents.interaction.disclosureRequested, { level: "warn", source: "domain.rbt.benchmarks", message });
        }
      }));
    }
  }

  stop(): void {
    while (this.unsubscribers.length) this.unsubscribers.pop()?.();
  }
}
