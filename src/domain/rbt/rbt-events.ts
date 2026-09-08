import { defineEventCatalog, event } from "../../core/events/index.js";
import type { ScoutAgentRole } from "../../agent/thread/types.js";

/** Final immutable locator for one Runtime-owned RBT campaign transcript. */
export interface RbtCampaignArtifactPublishedEvent {
  artifactId: string;
  campaignId: string;
  taskId?: string;
  agentId: string;
  role: ScoutAgentRole;
  ref: string;
  digest: string;
  status: "finalized";
  commandCount: number;
  startedAt: string;
  endedAt: string;
  publishedAt: string;
}

/** Persisted event routes owned by the RBT Domain. */
export const RbtEvents = defineEventCatalog("domain.rbt", {
  campaign: {
    artifactPublished: event<RbtCampaignArtifactPublishedEvent>(),
  },
} as const);
