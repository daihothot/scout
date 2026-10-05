import { parseArtifactReference } from "../../../core/io/index.js";
import type { ScoutAgentPhase } from "../../../agent/thread/types.js";
import { AgentEvents } from "../../../agent/events/index.js";
import { attachments } from "../../../agent/context/attachments.js";
import { CoordinatorContextTags } from "../../../agent/runner/coordinator/coordinator-attachments.js";
import { EventSubscriptionPriorities, type UnsubscribeEventHandler } from "../../../core/events/index.js";
import { resolveSynthesisRole } from "../../../core/workflow/index.js";
import type { WorkflowData } from "../../../core/workflow/workflow-data.js";
import { currentRunScope } from "../../../run/run-scope.js";
import { RunEvents } from "../../../run/events/index.js";
import type { ExecutionPlatformRequest } from "../../../execution/execution-command.js";
import {
  ScoutDomainId,
  type ScoutDomain,
  type ScoutDomainDescription,
} from "../../types.js";
import type { DomainAgentToolRegistration } from "../../agent/index.js";
import { BaseDomain } from "../base/index.js";
import {
  jarvisBehaviorAgentTool,
  RbtDomainAgentBackend,
  RbtAgentToolCallRecorder,
  JarvisBehaviorTool,
  JarvisWebSocketTool,
} from "./agent/index.js";
import {
  JarvisBehaviorCommandRunner,
  JarvisBehaviorExecuteFileRunner,
  JarvisBehaviorOrchestrator,
  JarvisBehaviorToolStore,
  RbtCampaignExecutionHistoryStore,
  JarvisBehaviorWebSocketLinker,
} from "./core/index.js";
import { loadRbtConfig, type RbtConfig } from "./config/index.js";
import { RbtEvents, type RbtExecutionHistoryReadyEvent } from "./rbt-events.js";
import { RbtRecordObject } from "./record/rbt-record-object.js";
import { RbtDomainProjector } from "./projector/rbt-domain-projector.js";
import { RbtArtifact } from "./artifacts/rbt-artifact.js";
import type { RbtExecutionHistory } from "./artifacts/types.js";
import { RbtBenchmarks } from "./rbt-benchmarks.js";

export interface RbtDomainRuntimeOptions {
  executable?: string;
  baseArgs?: readonly string[];
  websocket?: JarvisWebSocketTool;
  executionRequest?: () => ExecutionPlatformRequest;
}

/** Owns the RBT Domain lifecycle, journal, and Agent backend. */
export class RbtDomain implements ScoutDomain {
  readonly description: ScoutDomainDescription = Object.freeze({
    id: ScoutDomainId.Rbt,
    name: "Scout Runtime Behavioral Test Domain",
  });
  readonly recordObject = new RbtRecordObject();
  readonly benchmarks = new RbtBenchmarks();
  private readonly artifact = new RbtArtifact();
  private readonly toolCallRecorder = new RbtAgentToolCallRecorder();
  private readonly campaignHistoryStore = new RbtCampaignExecutionHistoryStore();
  private readonly behaviorStore = new JarvisBehaviorToolStore();
  private readonly websocket: JarvisWebSocketTool;
  private readonly behaviorOrchestrator: JarvisBehaviorOrchestrator;
  private unsubscribeHistoryReady?: UnsubscribeEventHandler;
  private unsubscribeRestoredHistoryReady?: UnsubscribeEventHandler;
  private activeConfig?: RbtConfig;
  private readonly executionRequest: () => ExecutionPlatformRequest;
  private baseDomain?: BaseDomain;
  private started = false;
  private cleanupFailed = false;
  private stopping?: Promise<void>;
  private readonly registeredAgentTools: Array<{
    phase: ScoutAgentPhase;
    registration: DomainAgentToolRegistration;
  }> = [];
  private readonly agentTools: Readonly<{
    executeBehavior: DomainAgentToolRegistration;
    reviewBehavior: DomainAgentToolRegistration;
  }>;
  readonly backend: RbtDomainAgentBackend;

  constructor(options: RbtDomainRuntimeOptions = {}) {
    const executable = options.executable ?? "jarvis";
    const baseArgs = options.baseArgs ?? [];
    const executionRequest = options.executionRequest ?? (() => {
      const { transport, platform, appId } = this.config.execution;
      const request: ExecutionPlatformRequest = {
        ...(transport ? { transport } : {}),
        ...(platform ? { platform } : {}),
        ...(appId ? { appId } : {}),
      };
      return request;
    });
    this.executionRequest = executionRequest;
    this.websocket = options.websocket ?? new JarvisWebSocketTool();
    this.behaviorOrchestrator = new JarvisBehaviorOrchestrator(
      this.executionRequest,
      {
        execute: new JarvisBehaviorWebSocketLinker("execute", executable, baseArgs, this.websocket),
        review: new JarvisBehaviorWebSocketLinker("review", executable, baseArgs, this.websocket),
      },
      {
        execute: new JarvisBehaviorCommandRunner("execute", executable, baseArgs, this.behaviorStore),
        review: new JarvisBehaviorCommandRunner("review", executable, baseArgs, this.behaviorStore),
      },
      new JarvisBehaviorExecuteFileRunner(this.behaviorStore),
      this.behaviorStore,
    );
    this.backend = new RbtDomainAgentBackend();
    this.agentTools = Object.freeze({
      executeBehavior: Object.freeze({
        definition: jarvisBehaviorAgentTool,
        tool: new JarvisBehaviorTool("execute", this.behaviorOrchestrator),
      }),
      reviewBehavior: Object.freeze({
        definition: jarvisBehaviorAgentTool,
        tool: new JarvisBehaviorTool("review", this.behaviorOrchestrator),
      }),
    });
  }

  get config(): RbtConfig {
    if (!this.activeConfig) {
      throw new Error("RBT Domain config is not available before the Domain starts.");
    }
    return this.activeConfig;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.stopping || this.cleanupFailed || this.registeredAgentTools.length > 0 || this.baseDomain) {
      throw new Error("Cannot start RBT Domain before its previous cleanup completes.");
    }
    const scope = currentRunScope();
    try {
      this.activeConfig = loadRbtConfig(scope.config);
      this.recordObject.start();
      this.benchmarks.start();
      this.artifact.start();
      this.backend.register("execute", this.agentTools.executeBehavior);
      this.registeredAgentTools.push({
        phase: "execute",
        registration: this.agentTools.executeBehavior,
      });
      this.backend.register("review", this.agentTools.reviewBehavior);
      this.registeredAgentTools.push({
        phase: "review",
        registration: this.agentTools.reviewBehavior,
      });
      const baseDomain = scope.domainRegistry.get(ScoutDomainId.Base);
      if (!(baseDomain instanceof BaseDomain)) {
        throw new Error("Registered Base Domain has an invalid runtime type.");
      }
      baseDomain.execution.configure(this.executionRequest());
      baseDomain.backend.register("review", baseDomain.agentTools.executionPlatform);
      this.baseDomain = baseDomain;
      this.unsubscribeHistoryReady = scope.eventBus.subscribe<RbtExecutionHistoryReadyEvent>(
        RbtEvents.history.ready,
        (event) => this.deliverHistoryRef(event.payload, event.occurredAt),
      );
      this.toolCallRecorder.start();
      this.campaignHistoryStore.start();
      this.started = true;
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "RBT Domain startup and cleanup failed.");
      }
      throw error;
    }
  }

  create(): void {
    this.unsubscribeRestoredHistoryReady?.();
    this.unsubscribeRestoredHistoryReady = undefined;
    this.behaviorStore.clear();
    this.artifact.clear();
  }

  async restore(workflowData: WorkflowData): Promise<void> {
    if (workflowData.status === "completed") return;
    await this.behaviorOrchestrator.quiesce();
    this.unsubscribeRestoredHistoryReady?.();
    this.unsubscribeRestoredHistoryReady = undefined;
    this.behaviorStore.clear();
    await this.websocket.stop();
    this.recordObject.attach(currentRunScope().workflow.journalRoot);
    const records = this.recordObject.read();
    const runtimeData = new RbtDomainProjector().project(records);
    this.artifact.restore(runtimeData.artifacts);
    const { histories } = runtimeData.artifacts;
    if (histories.size === 0) {
      return;
    }
    const scope = currentRunScope();
    let cancelled = false;
    const unsubscribe = scope.eventBus.subscribeOnce(RunEvents.runtime.ready, async () => {
      try {
        if (cancelled) return;
        const coordinatorRole = resolveSynthesisRole(scope.workflow.graph.snapshot()).name;
        const coordinator = scope.agentRegistry.listAgents().find((agent) => agent.role === coordinatorRole);
        if (!coordinator) {
          throw new Error("Cannot deliver restored RBT histories without the Coordinator agent.");
        }
        // Agent message restoration is complete at runtime.ready. Its journal
        // facts also cover deliveries already consumed before the interruption.
        const acceptedMessages = new Set(scope.workflow.readEvents().flatMap((event) =>
          (AgentEvents.message.queued.is(event) || AgentEvents.message.consumed.is(event))
            && event.payload.agentId === coordinator.agentId
            ? [event.payload.messageId]
            : [],
        ));
        for (const { history, occurredAt } of histories.values()) {
          if (cancelled) return;
          const messageId = `${scope.runId}-${workflowData.workflowId}-rbt-history-${history.agentId}-${history.runtimeSequence}`;
          if (acceptedMessages.has(messageId)) continue;
          await this.deliverHistoryRef(history, occurredAt);
          acceptedMessages.add(messageId);
        }
      } finally {
        if (this.unsubscribeRestoredHistoryReady === cancel) {
          this.unsubscribeRestoredHistoryReady = undefined;
        }
      }
    });
    const cancel = () => {
      cancelled = true;
      unsubscribe();
    };
    this.unsubscribeRestoredHistoryReady = cancel;
  }

  run(): void { this.behaviorOrchestrator.start(); }

  async close(): Promise<void> {
    await this.behaviorOrchestrator.quiesce();
    this.unsubscribeRestoredHistoryReady?.();
    this.unsubscribeRestoredHistoryReady = undefined;
    await this.websocket.stop();
  }

  async abort(): Promise<void> {
    await this.behaviorOrchestrator.quiesce();
    this.unsubscribeRestoredHistoryReady?.();
    this.unsubscribeRestoredHistoryReady = undefined;
    await this.websocket.stop();
  }

  clearWorkflow(): void {
    this.behaviorStore.clear();
    this.artifact.clear();
    this.campaignHistoryStore.clearWorkflow();
    this.recordObject.release();
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.started = false;
    this.stopping = (async () => {
      await this.behaviorOrchestrator.quiesce();
      const failures: unknown[] = [];
      for (const release of [
        () => this.artifact.stop(),
        () => this.benchmarks.stop(),
        () => this.recordObject.stop(),
        () => {
          this.unsubscribeHistoryReady?.();
          this.unsubscribeHistoryReady = undefined;
        },
        () => {
          this.unsubscribeRestoredHistoryReady?.();
          this.unsubscribeRestoredHistoryReady = undefined;
        },
        () => {
          if (!this.baseDomain) return;
          this.baseDomain.backend.unregister("review", this.baseDomain.agentTools.executionPlatform);
          this.baseDomain = undefined;
        },
        ...[...this.registeredAgentTools].reverse().map((registered) => () => {
          this.backend.unregister(registered.phase, registered.registration);
          this.registeredAgentTools.splice(this.registeredAgentTools.indexOf(registered), 1);
        }),
        () => this.campaignHistoryStore.stop(),
        () => this.toolCallRecorder.stop(),
        () => this.behaviorStore.clear(),
        () => this.websocket.stop(),
        () => this.recordObject.close(),
      ]) {
        try {
          await release();
        } catch (error) {
          failures.push(error);
        }
      }
      this.activeConfig = undefined;
      this.cleanupFailed = failures.length > 0;
      if (failures.length > 0) throw new AggregateError(failures, "Failed to stop RBT Domain.");
    })();
    try {
      await this.stopping;
    } finally {
      this.stopping = undefined;
    }
  }

  private async deliverHistoryRef(history: RbtExecutionHistory, occurredAt: string): Promise<void> {
    const scope = currentRunScope();
    const workflowData = scope.workflow.snapshot();
    if (!workflowData) throw new Error("RBT history delivery requires an active Workflow.");
    const coordinatorRole = resolveSynthesisRole(scope.workflow.graph.snapshot()).name;
    const coordinator = scope.agentRegistry.listAgents().find((agent) => agent.role === coordinatorRole);
    if (!coordinator) return;
    const delivered = await coordinator.sendMessage({
      message: attachments.addTagBlock(CoordinatorContextTags.Observation, [
        "### RBT Execution History Ready",
        "",
        `- executor_history_ref: ${JSON.stringify(parseArtifactReference(history.executorHistoryRef))}`,
        `- execute_file_ref: ${JSON.stringify(parseArtifactReference(history.executeFileRef))}`,
        `- runtime_sequence: ${history.runtimeSequence}`,
        `- campaign_id: ${history.campaignId}`,
        `- scenario_id: ${history.scenarioId}`,
        `- status: ${history.status}`,
      ].join("\n")),
      deliveryMode: "queued",
      delivery: {
        messageId: `${scope.runId}-${workflowData.workflowId}-rbt-history-${history.agentId}-${history.runtimeSequence}`,
        queuedAt: occurredAt,
      },
    });
    if (!delivered.ok) throw new Error(delivered.error);
  }
}
