import {
  defineEventCatalog,
  event,
} from "../../core/events/index.js";
import type { ScoutAgentRole } from "../../agent/thread/types.js";

/** Event payload recording a validated artifact reference and digest. */
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

/** Event payload recording the immutable digest and outcome of a validation gate. */
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

/** Event keys emitted by the validation domain when artifacts and gates become facts. */
export const ValidationEvents = defineEventCatalog("domain.validation", {
  artifact: {
    published: event<ValidationArtifactPublishedEvent>(),
  },
  gate: {
    recorded: event<ValidationGateRecordedEvent>(),
  },
} as const);
