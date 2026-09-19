import type { ScoutAgentPhase } from "../../agent/thread/types.js";
import { attachments } from "../../agent/context/attachments.js";
import { CoordinatorContextTags } from "../../agent/runner/coordinator/coordinator-attachments.js";
import type { UnsubscribeEventHandler } from "../../core/events/index.js";
import { resolveSynthesisRole } from "../../core/workflow/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import type { ScoutDomain, ScoutDomainDynamicToolCall } from "../types.js";
import {
  RbtAgentDynamicToolBackend,
  RbtAgentToolCallRecorder,
  RbtCampaignExecutionHistoryStore,
  rbtAgentDynamicToolsForPhase,
} from "./agent/index.js";
import { RbtEvents, type RbtExecutionHistoryReadyEvent } from "./rbt-events.js";

/** Owns the RBT Domain lifecycle and delegates its Agent-facing operations. */
export class RbtDomain implements ScoutDomain {
  readonly domainId = "rbt";
  readonly name = "Scout Runtime Behavioral Test Domain";
  private readonly toolCallRecorder = new RbtAgentToolCallRecorder();
  private readonly campaignHistoryStore = new RbtCampaignExecutionHistoryStore();
  private unsubscribeHistoryReady?: UnsubscribeEventHandler;
  private started = false;

  constructor(readonly dynamicTool = new RbtAgentDynamicToolBackend()) {}

  dynamicToolsForPhase(phase: ScoutAgentPhase) {
    return rbtAgentDynamicToolsForPhase(phase);
  }

  handleDynamicToolCall(
    call: ScoutDomainDynamicToolCall,
  ) {
    return this.dynamicTool.handleDynamicToolCall(call);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.unsubscribeHistoryReady = currentRunScope().eventBus.subscribe<RbtExecutionHistoryReadyEvent>(
      RbtEvents.history.ready,
      (event) => this.deliverHistoryRef(event.payload),
    );
    this.toolCallRecorder.start();
    this.campaignHistoryStore.start();
    this.started = true;
  }

  restore(): void {}

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.unsubscribeHistoryReady?.();
    this.unsubscribeHistoryReady = undefined;
    this.campaignHistoryStore.stop();
    this.toolCallRecorder.stop();
    await this.dynamicTool.stop();
  }

  private async deliverHistoryRef(history: RbtExecutionHistoryReadyEvent): Promise<void> {
    const scope = currentRunScope();
    const coordinatorRole = resolveSynthesisRole(scope.scheduler.snapshot()).name;
    const coordinator = scope.agentRegistry.listAgents().find((agent) => agent.role === coordinatorRole);
    if (!coordinator) return;
    const delivered = await coordinator.sendMessage({
      message: attachments.addTagBlock(CoordinatorContextTags.Observation, [
        "### RBT Execution History Ready",
        "",
        `- executor_history_ref: ${history.executorHistoryRef}`,
        `- execute_file_ref: ${history.executeFileRef}`,
        `- runtime_sequence: ${history.runtimeSequence}`,
        `- campaign_id: ${history.campaignId}`,
        `- scenario_id: ${history.scenarioId}`,
        `- status: ${history.status}`,
      ].join("\n")),
      deliveryMode: "queued",
      delivery: {
        messageId: `${scope.runId}-rbt-history-${history.agentId}-${history.runtimeSequence}`,
        queuedAt: new Date().toISOString(),
      },
    });
    if (!delivered.ok) throw new Error(delivered.error);
  }
}
