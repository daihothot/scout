import type { ScoutAgentPhase } from "../../agent/thread/types.js";
import type { ScoutDomain, ScoutDomainDynamicToolCall } from "../types.js";
import {
  RbtAgentDynamicToolBackend,
  RbtAgentToolCallRecorder,
  RbtCampaignExecutionHistoryStore,
  rbtAgentDynamicToolsForPhase,
} from "./agent/index.js";

/** Owns the RBT Domain lifecycle and delegates its Agent-facing operations. */
export class RbtDomain implements ScoutDomain {
  readonly domainId = "rbt";
  readonly name = "Scout Runtime Behavioral Test Domain";
  private readonly toolCallRecorder = new RbtAgentToolCallRecorder();
  private readonly campaignHistoryStore = new RbtCampaignExecutionHistoryStore();
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
    this.toolCallRecorder.start();
    this.campaignHistoryStore.start();
    this.started = true;
  }

  restore(): void {}

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.campaignHistoryStore.stop();
    this.toolCallRecorder.stop();
    await this.dynamicTool.stop();
  }
}
