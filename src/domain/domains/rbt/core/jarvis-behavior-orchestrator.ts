import type { DynamicToolCallResponse } from "../../../../agent-server/types.js";
import type { AgentJsonValue } from "../../../../agent/tools/types.js";
import type { ExecutionPlatformRequest, ExecutionSelectionIdentity } from "../../../../execution/index.js";
import type { ScoutDomainDynamicToolCall } from "../../../types.js";
import { currentRunScope } from "../../../../run/run-scope.js";
import { BaseDomain } from "../../base/index.js";
import { ScoutDomainId } from "../../../types.js";
import type { BehaviorCommandExecution } from "./jarvis-behavior-command-runner.js";
import { JarvisBehaviorCommandRunner } from "./jarvis-behavior-command-runner.js";
import { JarvisBehaviorExecuteFileRunner } from "./jarvis-behavior-execute-file.js";
import { readJarvisBehaviorExecuteFile } from "./jarvis-behavior-execute-file-reader.js";
import type { JarvisBehaviorToolStore } from "./jarvis-behavior-tool-store.js";
import {
  JarvisBehaviorWebSocketLinker,
  type JarvisBehaviorLinkContext,
  type JarvisBehaviorLinkResult,
} from "./jarvis-behavior-websocket-linker.js";

export type JarvisBehaviorPhase = "execute" | "review";

/** Owns the full RBT path from execution-target readiness through one runtime transaction. */
export class JarvisBehaviorOrchestrator {
  private accepting = false;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly activeFiles = new Set<Promise<DynamicToolCallResponse>>();

  constructor(
    private readonly executionRequest: () => ExecutionPlatformRequest,
    private readonly linkers: Readonly<Record<JarvisBehaviorPhase, JarvisBehaviorWebSocketLinker>>,
    private readonly commandRunners: Readonly<Record<JarvisBehaviorPhase, JarvisBehaviorCommandRunner>>,
    private readonly executeFileRunner: JarvisBehaviorExecuteFileRunner,
    private readonly store: JarvisBehaviorToolStore,
  ) {}

  start(): void {
    this.accepting = true;
  }

  async quiesce(): Promise<void> {
    this.accepting = false;
    await this.operationTail;
    await Promise.allSettled([...this.activeFiles]);
  }

  async executeCommand(
    phase: JarvisBehaviorPhase,
    call: ScoutDomainDynamicToolCall,
    command: string,
    payload: Record<string, AgentJsonValue>,
  ): Promise<DynamicToolCallResponse> {
    const request = structuredClone(this.executionRequest());
    return this.enqueue(async () => {
      const linked = await this.ensureLinked(phase, call, request);
      if (!linked.ok) return linkFailure(linked);
      const execution = await this.runCommand(phase, call, command, payload, linked.context);
      const output: AgentJsonValue = execution.status === "completed"
        ? { status: "completed", command, result: execution.result?.payload ?? null }
        : commandFailureOutput(command, execution);
      return dynamicResponse(execution.status === "completed", output);
    });
  }

  async executeFile(
    call: ScoutDomainDynamicToolCall,
    executeFileRef: string,
  ): Promise<DynamicToolCallResponse> {
    if (!this.accepting) throw new Error("RBT runtime is not accepting commands.");
    const executeFile = readJarvisBehaviorExecuteFile(call, executeFileRef, this.store);
    const request = structuredClone(this.executionRequest());
    const execution = (async () => {
      const prepared = await this.enqueue(async () => {
        const linked = await this.ensureLinked("execute", call, request);
        if (!linked.ok) return linked;
        const baseDomain = currentRunScope().domainRegistry.get(ScoutDomainId.Base);
        if (!(baseDomain instanceof BaseDomain)) throw new Error("Registered Base Domain has an invalid runtime type.");
        const target = baseDomain.execution.current(request);
        if (!target.ok || !target.started) {
          throw new Error("The RBT execution target changed before execute-file preparation completed.");
        }
        return { ...linked, identity: target.identity };
      });
      if (!prepared.ok) return linkFailure(prepared);
      return this.executeFileRunner.run(
        call,
        executeFile,
        prepared.context.platform,
        (command, payload) => this.enqueue(async () => {
          const linked = await this.ensureLinked("execute", call, request, prepared.identity);
          if (!linked.ok) throw new Error(`${linked.code}: ${linked.message}`);
          return this.runCommand("execute", call, command, payload, linked.context);
        }),
      );
    })();
    this.activeFiles.add(execution);
    try {
      return await execution;
    } finally {
      this.activeFiles.delete(execution);
    }
  }

  private async ensureLinked(
    phase: JarvisBehaviorPhase,
    call: ScoutDomainDynamicToolCall,
    request: ExecutionPlatformRequest,
    expectedTarget?: ExecutionSelectionIdentity,
  ): Promise<JarvisBehaviorLinkResult> {
    const linker = this.linkers[phase];
    const baseDomain = currentRunScope().domainRegistry.get(ScoutDomainId.Base);
    if (!(baseDomain instanceof BaseDomain)) {
      throw new Error("Registered Base Domain has an invalid runtime type.");
    }
    const targetRuntime = baseDomain.execution;
    const target = expectedTarget
      ? targetRuntime.current({ ...request, identity: expectedTarget })
      : phase === "execute"
      ? await targetRuntime.resolve(request)
      : targetRuntime.current(request);
    if (!target.ok) return { ...target, hostCommands: [] };
    if ((phase === "review" || expectedTarget) && !target.started) {
      return {
        ok: false,
        code: "execution_target_not_started",
        message: "The RBT execution target is not running in the current Domain runtime.",
        hostCommands: [],
      };
    }

    const prepared = await linker.prepare(target.identity.platform, !target.started);
    if (!prepared.ok) return prepared;
    let rollbackLaunchId: string | undefined;
    let linked: JarvisBehaviorLinkResult;
    try {
      if (phase === "execute" && !expectedTarget) {
        const started = await targetRuntime.ensureStarted({
          ...request,
          parameters: {
            ...(request.parameters ?? {}),
            ...prepared.launchParameters,
          },
        }, target.identity);
        if (!started.ok) {
          linked = { ...started, hostCommands: [] };
        } else {
          if (started.launched) rollbackLaunchId = started.launchId;
          linked = await linker.connect(call, target.identity.platform);
        }
      } else {
        linked = await linker.connect(call, target.identity.platform);
      }
    } catch (error) {
      linked = {
        ok: false,
        code: "rbt_connection_failed",
        message: error instanceof Error ? error.message : String(error),
        hostCommands: [],
      };
    }
    if (!linked.ok) {
      const cleanupFailures: unknown[] = [];
      try {
        await linker.abort();
      } catch (error) {
        cleanupFailures.push(error);
      }
      if (rollbackLaunchId !== undefined) {
        try {
          const stopped = await targetRuntime.rollbackStart(request, target.identity, rollbackLaunchId);
          if (!stopped.ok) {
            if (cleanupFailures.length === 0) return { ...stopped, hostCommands: linked.hostCommands };
            cleanupFailures.push(new Error(`${stopped.code}: ${stopped.message}`));
          }
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError([
          new Error(`${linked.code}: ${linked.message}`), ...cleanupFailures,
        ], "RBT connection and cleanup failed.");
      }
    }
    return linked;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error("RBT runtime is not accepting commands."));
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async runCommand(
    phase: JarvisBehaviorPhase,
    call: ScoutDomainDynamicToolCall,
    command: string,
    payload: Record<string, AgentJsonValue>,
    initialContext: JarvisBehaviorLinkContext,
  ): Promise<BehaviorCommandExecution> {
    const commandRunner = this.commandRunners[phase];
    const linker = this.linkers[phase];
    const first = await commandRunner.run(call, command, payload, initialContext);
    if (!first.retryableTransportFailure) return first;

    const reconnected = await linker.reconnect(call, initialContext);
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
    const second = await commandRunner.run(call, command, payload, reconnected.context);
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
