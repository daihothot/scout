import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type { ScoutAgentRole } from "../thread/types.js";

/** Normalized shell-command fact exposed to Scout's generic agent telemetry. */
export interface AgentCommandExecutionObservedEvent {
  sourceSeq: number;
  agentId: string;
  role: ScoutAgentRole;
  taskId?: string;
  threadId: string;
  turnId?: string;
  itemId: string;
  command: string;
  cwd?: string;
  status: string;
  exitCode?: number | null;
  durationMs?: number | null;
  observedAt: string;
}

const agentCommandExecutionEventCatalog = {
  commandExecution: {
    observed: event<AgentCommandExecutionObservedEvent>(),
  },
} as const;

AgentEvents.add(agentCommandExecutionEventCatalog);

/** Event routes for shell-command observations without command output. */
export type AgentCommandExecutionEventCatalog =
  typeof agentCommandExecutionEventCatalog;
