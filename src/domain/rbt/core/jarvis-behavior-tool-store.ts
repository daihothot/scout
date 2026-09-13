import type { RbtExecutionPlatform } from "../rbt-events.js";

export interface JarvisBehaviorExecutionState {
  executeFilePath: string;
  executeFileRef: string;
  bddId: string;
  targetVersion: string;
  runtimeSequence: number;
  campaignId: string;
  scenarioId: string;
}

/** Owns one JarvisBehavior tool instance's mutable session and execution state. */
export class JarvisBehaviorToolStore {
  private readonly platforms = new Map<string, RbtExecutionPlatform>();
  private readonly activeExecutions = new Map<string, JarvisBehaviorExecutionState>();
  private readonly configuredSessions = new Set<string>();
  private readonly commandSequences = new Map<string, number>();
  private readonly runtimeSequences = new Map<string, number>();

  platform(agentId: string): RbtExecutionPlatform | undefined {
    const platform = this.platforms.get(agentId);
    return platform ? structuredClone(platform) : undefined;
  }

  setPlatform(agentId: string, platform: RbtExecutionPlatform): void {
    this.platforms.set(agentId, structuredClone(platform));
  }

  removePlatform(agentId: string): void {
    this.platforms.delete(agentId);
  }

  schemaConfigured(sessionId: string): boolean {
    return this.configuredSessions.has(sessionId);
  }

  markSchemaConfigured(sessionId: string): void {
    this.configuredSessions.add(sessionId);
  }

  clearSchemaConfiguration(sessionId: string): void {
    this.configuredSessions.delete(sessionId);
  }

  activeExecution(agentId: string): JarvisBehaviorExecutionState | undefined {
    const execution = this.activeExecutions.get(agentId);
    return execution ? structuredClone(execution) : undefined;
  }

  startExecution(agentId: string, execution: JarvisBehaviorExecutionState): void {
    if (this.activeExecutions.has(agentId)) {
      throw new Error(`An RBT execute-file is already running for Agent ${agentId}.`);
    }
    this.activeExecutions.set(agentId, structuredClone(execution));
  }

  finishExecution(agentId: string): void {
    this.activeExecutions.delete(agentId);
  }

  nextCorrelationId(runId: string, agentId: string, command: string): string {
    const sequence = (this.commandSequences.get(agentId) ?? 0) + 1;
    this.commandSequences.set(agentId, sequence);
    const commandName = command
      .replace(/^behavior\./, "")
      .replaceAll(/[^A-Za-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "");
    return `${runId}/cmd/${String(sequence).padStart(3, "0")}-${commandName}`;
  }

  nextRuntimeSequence(agentId: string, existingMaximum: number): number {
    const sequence = Math.max(this.runtimeSequences.get(agentId) ?? 0, existingMaximum) + 1;
    this.runtimeSequences.set(agentId, sequence);
    return sequence;
  }

  clear(): void {
    this.platforms.clear();
    this.activeExecutions.clear();
    this.configuredSessions.clear();
    this.commandSequences.clear();
    this.runtimeSequences.clear();
  }
}
