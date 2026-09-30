import type { UnsubscribeEventHandler } from "../../../core/events/index.js";
import { currentRunScope } from "../../../run/run-scope.js";
import { SystemEvents } from "../../../system/events/index.js";
import { DomainBenchmarks } from "../../core/benchmarks/index.js";
import { ScoutDomainId } from "../../types.js";
import { RbtEvents } from "./rbt-events.js";
import type { RbtCampaignCommandEvent, RbtExecutionHistoryReadyEvent } from "./rbt-events.js";
import type {
  RbtExecutionReference, RbtExecutionHistoryReference, RbtExecutionPackReference,
  RbtReviewerPackReference,
} from "./artifacts/types.js";

/** A successful review points at the reviewed Execution Pack, with its precise supporting evidence. */
export interface RbtReviewSuccessReference extends RbtExecutionPackReference {
  reviewerPack: RbtReviewerPackReference;
}

/** Nodes exist only after their corresponding fact has occurred. */
export interface RbtBenchmarkEntry {
  history: {
    lastRun?: RbtExecutionReference;
    lastExecutionSuccess?: RbtExecutionHistoryReference;
    lastExecutionPack?: RbtExecutionPackReference;
    lastReviewerPack?: RbtReviewerPackReference;
    lastReviewSuccess?: RbtReviewSuccessReference;
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
    for (const target of [RbtEvents.campaign.start, RbtEvents.history.ready, RbtEvents.artifact]) {
      this.unsubscribers.push(scope.eventBus.subscribe(target, (event) => {
        try {
          if (RbtEvents.campaign.start.is(event)) {
            const fact = event.payload;
            this.submit([{ path: ["bddCatalog", fact.bddId, fact.targetVersion, "history", "lastRun"], value: this.executionReference(fact) }]);
          } else if (RbtEvents.history.ready.is(event) && event.payload.status === "completed") {
            const fact = event.payload;
            const execution = this.executionReference(fact);
            const historyPath = `history/${String(fact.runtimeSequence).padStart(3, "0")}.json`;
            if (fact.executorHistoryRef !== `scout-artifact://${execution.workflowId}/${fact.agentId}/${historyPath}`) {
              throw new Error("RBT execution history reference does not match its execution identity.");
            }
            this.submit([{ path: ["bddCatalog", fact.bddId, fact.targetVersion, "history", "lastExecutionSuccess"], value: {
              ...execution,
              executorHistory: { workflowId: execution.workflowId, agentId: fact.agentId, path: historyPath, digest: fact.executorHistoryDigest, algorithm: "sha256" },
            } }]);
          } else if (RbtEvents.artifact.executionPackSubmitted.is(event)) {
            const fact = event.payload;
            this.submit([{ path: ["bddCatalog", fact.bddId, fact.targetVersion, "history", "lastExecutionPack"], value: fact.pack }]);
          } else if (RbtEvents.artifact.reviewSubmitted.is(event)) {
            const fact = event.payload;
            const path = ["bddCatalog", fact.bddId, fact.targetVersion];
            if (fact.pack.result !== "pass") {
              this.submit([{ path: [...path, "history", "lastReviewerPack"], value: fact.pack }]);
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
              { path: [...path, "history", "lastReviewerPack"], value: fact.pack },
              { path: [...path, "history", "lastReviewSuccess"], value: { ...fact.pack.executionPack, reviewerPack: fact.pack } },
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

  private executionReference(fact: RbtCampaignCommandEvent | RbtExecutionHistoryReadyEvent): RbtExecutionReference {
    const workflow = currentRunScope().workflow.snapshot();
    if (!workflow) throw new Error("RBT Benchmarks require an active Workflow.");
    const path = `${fact.bddId}/${fact.targetVersion}/execute-file.json`;
    if (fact.executeFileRef !== `scout-artifact://${workflow.workflowId}/${fact.agentId}/${path}`) {
      throw new Error("RBT execute-file reference does not match its execution identity.");
    }
    return {
      workflowId: workflow.workflowId,
      agentId: fact.agentId,
      runtimeSequence: fact.runtimeSequence,
      campaignId: fact.campaignId,
      scenarioId: fact.scenarioId,
      platform: { ...fact.platform },
      executeFile: { workflowId: workflow.workflowId, agentId: fact.agentId, path, digest: fact.executeFileDigest, algorithm: "sha256" },
    };
  }
}
