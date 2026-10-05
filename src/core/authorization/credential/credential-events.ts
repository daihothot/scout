import { defineEventCatalog, event } from "../../events/index.js";
export interface CredentialIssuedEvent {
  readonly credentialId: string;
  readonly sourceId: string;
  readonly sourceType: string;
  readonly workflowId: string;
  readonly issuedAt: string;
  readonly scope: object;
  readonly target: object;
}

export interface CredentialUsedEvent {
  readonly credentialId: string;
  readonly approvalId: string;
  readonly sourceId: string;
  readonly workflowId: string;
  readonly usedAt: string;
  readonly consumer: object;
}

/** Issuance is derived from a new approval; each credential use is its own durable fact. */
export const CredentialEvents = defineEventCatalog("system", {
  authorizationCredential: {
    issued: event<CredentialIssuedEvent>(),
    used: event<CredentialUsedEvent>(),
  },
} as const);
