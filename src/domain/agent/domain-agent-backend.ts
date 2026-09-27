import { isDeepStrictEqual } from "node:util";
import type { DynamicToolCallResponse } from "../../agent-server/types.js";
import type { ScoutAgentPhase } from "../../agent/thread/types.js";
import type { AgentDynamicToolSpec } from "../../agent/tools/types.js";
import type { ScoutDomainDynamicToolCall } from "../types.js";

/** Executable implementation paired with one Domain Agent tool definition. */
export interface DomainAgentTool {
  execute(
    call: ScoutDomainDynamicToolCall,
  ): Promise<DynamicToolCallResponse> | DynamicToolCallResponse;
}

/** One constructed Domain Agent tool that may be registered in one or more Phases. */
export interface DomainAgentToolRegistration {
  readonly definition: AgentDynamicToolSpec;
  readonly tool: DomainAgentTool;
}

/** Owns Phase tool registrations while each Domain backend implements invocation. */
export abstract class DomainAgentBackend {
  protected readonly toolsByPhase = new Map<
    ScoutAgentPhase,
    Map<string, DomainAgentToolRegistration & { registrations: number }>
  >();

  register(phase: ScoutAgentPhase, registration: DomainAgentToolRegistration): void {
    const { definition, tool } = registration;
    const identity = this.toolIdentity(definition.namespace, definition.name);
    const phaseTools = this.toolsByPhase.get(phase)
      ?? new Map<string, DomainAgentToolRegistration & { registrations: number }>();
    const registered = phaseTools.get(identity);
    if (registered) {
      if (registered.tool !== tool || !isDeepStrictEqual(registered.definition, definition)) {
        throw new Error(
          `Domain Agent tool ${definition.namespace ?? "<none>"}/${definition.name}`
          + ` conflicts with its existing registration for Phase ${phase}.`,
        );
      }
      registered.registrations += 1;
    } else {
      phaseTools.set(identity, {
        definition: structuredClone(definition),
        tool,
        registrations: 1,
      });
    }
    this.toolsByPhase.set(phase, phaseTools);
  }

  unregister(phase: ScoutAgentPhase, registration: DomainAgentToolRegistration): void {
    const { definition, tool } = registration;
    const identity = this.toolIdentity(definition.namespace, definition.name);
    const phaseTools = this.toolsByPhase.get(phase);
    const registered = phaseTools?.get(identity);
    if (
      !phaseTools
      || !registered
      || registered.tool !== tool
      || !isDeepStrictEqual(registered.definition, definition)
    ) {
      throw new Error(
        `Domain Agent tool ${definition.namespace ?? "<none>"}/${definition.name}`
        + ` is not registered for Phase ${phase}.`,
      );
    }
    registered.registrations -= 1;
    if (registered.registrations === 0) phaseTools.delete(identity);
    if (phaseTools.size === 0) this.toolsByPhase.delete(phase);
  }

  dynamicToolsForPhase(phase: ScoutAgentPhase): AgentDynamicToolSpec[] {
    return [...(this.toolsByPhase.get(phase)?.values() ?? [])]
      .map((registered) => structuredClone(registered.definition));
  }

  abstract handleDynamicToolCall(
    call: ScoutDomainDynamicToolCall,
  ): Promise<DynamicToolCallResponse | undefined>;

  protected toolIdentity(namespace: string | null | undefined, name: string): string {
    return `${namespace ?? ""}\u0000${name}`;
  }
}
