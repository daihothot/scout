import {
  defineEventCatalog,
  event,
} from "../../core/events/index.js";
import type { ScoutAgentRole } from "../../agent/thread/types.js";

export interface ValidationArtifactPublishedEvent {
  artifactId: string;
  taskId?: string;
  agentId: string;
  role: ScoutAgentRole;
  ref: string;
  digest: string;
  status: string;
  publishedAt: string;
}

export interface ValidationGateRecordedEvent {
  gateId: string;
  taskId?: string;
  agentId: string;
  checkedRef: string;
  checkedDigest: string;
  gateRef: string;
  gateDigest: string;
  status: string;
  recordedAt: string;
}

export const ValidationEvents = defineEventCatalog("domain.validation", {
  artifact: {
    published: event<ValidationArtifactPublishedEvent>(),
  },
  gate: {
    recorded: event<ValidationGateRecordedEvent>(),
  },
} as const);
