import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type { ScoutAgentRole } from "../thread/types.js";

/** Complete shell-command result retained for runtime consumers and recovery. */
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
  aggregatedOutput?: string | null;
  durationMs?: number | null;
  observedAt: string;
}

const agentCommandExecutionEventCatalog = {
  commandExecution: {
    observed: event<AgentCommandExecutionObservedEvent>(),
  },
} as const;

AgentEvents.add(agentCommandExecutionEventCatalog);

/** Event routes for complete shell-command observations. */
export type AgentCommandExecutionEventCatalog =
  typeof agentCommandExecutionEventCatalog;
