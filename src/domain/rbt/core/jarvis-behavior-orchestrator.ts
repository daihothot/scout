import type { DynamicToolCallResponse } from "../../../agent-server/types.js";
import type { AgentJsonValue } from "../../../agent/tools/types.js";
import type { ExecutionPlatformRequest } from "../../../execution/index.js";
import type { ScoutDomainDynamicToolCall } from "../../types.js";
import type { BehaviorCommandExecution } from "./jarvis-behavior-command-runner.js";
import { JarvisBehaviorCommandRunner } from "./jarvis-behavior-command-runner.js";
import { JarvisBehaviorExecutionTargetGate } from "./jarvis-behavior-execution-target-gate.js";
import { JarvisBehaviorExecuteFileRunner } from "./jarvis-behavior-execute-file.js";
import { readJarvisBehaviorExecuteFile } from "./jarvis-behavior-execute-file-reader.js";
import type { JarvisBehaviorToolStore } from "./jarvis-behavior-tool-store.js";
import {
  JarvisBehaviorWebSocketLinker,
  type JarvisBehaviorLinkContext,
  type JarvisBehaviorLinkResult,
} from "./jarvis-behavior-websocket-linker.js";

/** Owns the full RBT path from execution-target readiness through one runtime transaction. */
export class JarvisBehaviorOrchestrator {
  private targetPrepared = false;

  constructor(
    private readonly executionRequest: () => ExecutionPlatformRequest,
    private readonly targetGate: JarvisBehaviorExecutionTargetGate,
    private readonly linker: JarvisBehaviorWebSocketLinker,
    private readonly commandRunner: JarvisBehaviorCommandRunner,
    private readonly executeFileRunner: JarvisBehaviorExecuteFileRunner,
    private readonly store: JarvisBehaviorToolStore,
  ) {}

  async executeCommand(
    call: ScoutDomainDynamicToolCall,
    command: string,
    payload: Record<string, AgentJsonValue>,
  ): Promise<DynamicToolCallResponse> {
    const linked = await this.ensureLinked(call);
    if (!linked.ok) return linkFailure(linked);
    const execution = await this.runCommand(call, command, payload, linked.context);
    const output: AgentJsonValue = execution.status === "completed"
      ? { status: "completed", command, result: execution.result?.payload ?? null }
      : commandFailureOutput(command, execution);
    return dynamicResponse(execution.status === "completed", output);
  }

  async executeFile(
    call: ScoutDomainDynamicToolCall,
    executeFileRef: string,
  ): Promise<DynamicToolCallResponse> {
    const executeFile = readJarvisBehaviorExecuteFile(call, executeFileRef, this.store);
    const linked = await this.ensureLinked(call);
    if (!linked.ok) return linkFailure(linked);
    let context = linked.context;
    return this.executeFileRunner.run(
      call,
      executeFile,
      context.platform,
      async (command, payload) => {
        const execution = await this.runCommand(call, command, payload, context);
        context = {
          ...context,
          freshSession: false,
          hostCommands: [],
        };
        return execution;
      },
    );
  }

  stop(): void {
    this.targetPrepared = false;
    this.targetGate.stop();
  }

  private async ensureLinked(
    call: ScoutDomainDynamicToolCall,
  ): Promise<JarvisBehaviorLinkResult> {
    const request = this.executionRequest();
    const target = await this.targetGate.resolve(request);
    if (!target.ok) return { ...target, hostCommands: [] };

    const prepared = await this.linker.prepare(target.identity, !target.started);
    if (!prepared.ok) return prepared;
    const started = await this.targetGate.ensureStarted({
      ...request,
      parameters: {
        ...(request.parameters ?? {}),
        ...prepared.launchParameters,
      },
    }, target.identity, !this.targetPrepared);
    if (!started.ok) {
      this.targetPrepared = false;
      await this.linker.abort();
      return { ...started, hostCommands: [] };
    }
    const linked = await this.linker.connect(call, started.identity);
    if (!linked.ok) {
      this.targetPrepared = false;
      await this.linker.abort();
      const stopped = await this.targetGate.ensureStopped(request, started.identity);
      if (!stopped.ok) return { ...stopped, hostCommands: linked.hostCommands };
    } else {
      this.targetPrepared = true;
    }
    return linked;
  }

  private async runCommand(
    call: ScoutDomainDynamicToolCall,
    command: string,
    payload: Record<string, AgentJsonValue>,
    initialContext: JarvisBehaviorLinkContext,
  ): Promise<BehaviorCommandExecution> {
    const first = await this.commandRunner.run(call, command, payload, initialContext);
    if (!first.retryableTransportFailure) return first;

    const reconnected = await this.linker.reconnect(call, initialContext);
    if (!reconnected.ok) {
      return {
        ...first,
        status: "failed",
        errorCode: reconnected.code,
        error: reconnected.message,
        hostCommands: [...first.hostCommands, ...reconnected.hostCommands],
        completedAt: new Date().toISOString(),
      };
    }
    const second = await this.commandRunner.run(call, command, payload, reconnected.context);
    return {
      ...second,
      hostCommands: [...first.hostCommands, ...second.hostCommands],
      startedAt: first.startedAt,
    };
  }
}

function linkFailure(failure: Extract<JarvisBehaviorLinkResult, { ok: false }>): DynamicToolCallResponse {
  return dynamicResponse(false, {
    status: "failed",
    error: { code: failure.code, message: failure.message },
  });
}

function commandFailureOutput(
  command: string,
  execution: BehaviorCommandExecution,
): AgentJsonValue {
  return {
    status: "failed",
    command,
    error: {
      code: execution.errorCode ?? "behavior_command_failed",
      message: execution.error ?? "Behavioral command failed.",
    },
  };
}

function dynamicResponse(success: boolean, output: AgentJsonValue): DynamicToolCallResponse {
  return { success, contentItems: [{ type: "inputText", text: JSON.stringify(output, null, 2) }] };
}
