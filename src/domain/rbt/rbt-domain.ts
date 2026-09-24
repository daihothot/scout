import type { ScoutAgentPhase } from "../../agent/thread/types.js";
import { attachments } from "../../agent/context/attachments.js";
import { CoordinatorContextTags } from "../../agent/runner/coordinator/coordinator-attachments.js";
import type { UnsubscribeEventHandler } from "../../core/events/index.js";
import { resolveSynthesisRole } from "../../core/workflow/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import type { ExecutionPlatformRequest } from "../../execution/execution-command.js";
import type { ScoutDomain, ScoutDomainDynamicToolCall } from "../types.js";
import {
  RbtAgentDynamicToolBackend,
  RbtAgentToolCallRecorder,
  RbtCampaignExecutionHistoryStore,
  rbtAgentDynamicToolsForPhase,
} from "./agent/index.js";
import { loadRbtConfig, type RbtConfig } from "./config/index.js";
import { RbtEvents, type RbtExecutionHistoryReadyEvent } from "./rbt-events.js";
import { RbtJournal } from "./rbt-journal.js";

/** Owns the RBT Domain lifecycle and delegates its Agent-facing operations. */
export class RbtDomain implements ScoutDomain {
  readonly domainId = "rbt";
  readonly name = "Scout Runtime Behavioral Test Domain";
  readonly journal = new RbtJournal();
  private readonly toolCallRecorder = new RbtAgentToolCallRecorder();
  private readonly campaignHistoryStore = new RbtCampaignExecutionHistoryStore();
  private unsubscribeHistoryReady?: UnsubscribeEventHandler;
  private activeConfig?: RbtConfig;
  private started = false;
  readonly dynamicTool: RbtAgentDynamicToolBackend;

  constructor(dynamicTool?: RbtAgentDynamicToolBackend) {
    this.dynamicTool = dynamicTool ?? new RbtAgentDynamicToolBackend({
      executionRequest: () => {
        const { transport, platform, appId } = this.config.execution;
        const request: ExecutionPlatformRequest = {
          ...(transport ? { transport } : {}),
          ...(platform ? { platform } : {}),
          ...(appId ? { appId } : {}),
        };
        return request;
      },
    });
  }

  dynamicToolsForPhase(phase: ScoutAgentPhase) {
    return rbtAgentDynamicToolsForPhase(phase);
  }

  handleDynamicToolCall(
    call: ScoutDomainDynamicToolCall,
  ) {
    return this.dynamicTool.handleDynamicToolCall(call);
  }

  get config(): RbtConfig {
    if (!this.activeConfig) {
      throw new Error("RBT Domain config is not available before the Domain starts.");
    }
    return this.activeConfig;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const scope = currentRunScope();
    this.activeConfig = loadRbtConfig(scope.config);
    this.unsubscribeHistoryReady = scope.eventBus.subscribe<RbtExecutionHistoryReadyEvent>(
      RbtEvents.history.ready,
      (event) => this.deliverHistoryRef(event.payload),
    );
    this.toolCallRecorder.start();
    this.campaignHistoryStore.start();
    this.started = true;
  }

  restore(): void {
    const fact = this.journal.aggregate(currentRunScope().domainJournal.readAll());
    this.dynamicTool.restoreRuntimeFact(fact);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.unsubscribeHistoryReady?.();
    this.unsubscribeHistoryReady = undefined;
    this.activeConfig = undefined;
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
