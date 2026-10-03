import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Approval, ApprovedResult } from "../approval/types.js";
import type { ScoutRequest } from "../request/types.js";
import type { Credential, CredentialUse } from "./types.js";

/** Owns runtime credentials and their use chain, not approval quota or native sandbox grants. */
export class CredentialChain {
  private readonly credentials = new Map<string, Credential>();
  private readonly usages = new Map<string, CredentialUse[]>();

  restore(runtimeObject: { credentials: readonly Credential[]; usages: readonly CredentialUse[] }): void {
    this.clearWorkflow();
    for (const credential of runtimeObject.credentials) this.credentials.set(credential.credentialId, credential);
    for (const use of runtimeObject.usages) this.acceptUse(use);
  }
  clearWorkflow(): void { this.credentials.clear(); this.usages.clear(); }

  /** Consumes a committed new approval; the approval is the durable issuance source. */
  issue(approval: Approval & { result: { decision: "approved"; scope: object; target: object } }): Credential {
    const credential: Credential = { credentialId: approval.approvalId, requestId: approval.requestId,
      requestType: approval.requestType, workflowId: approval.workflowId, issuedAt: approval.submittedAt,
      scope: structuredClone(approval.result.scope), target: structuredClone(approval.result.target) };
    this.credentials.set(credential.credentialId, credential);
    return structuredClone(credential);
  }
  match<TReq extends ScoutRequest>(request: TReq, grant: Pick<ApprovedResult<TReq>, "scope" | "target">): Credential<TReq> | undefined {
    return this.list(request).find((credential) => isDeepStrictEqual(credential.scope, grant.scope)
      && isDeepStrictEqual(credential.target, grant.target));
  }
  use(credential: Credential, request: ScoutRequest, consumer: object): CredentialUse {
    return { credentialId: credential.credentialId, approvalId: randomUUID(), requestId: request.requestId,
      workflowId: request.workflowId, usedAt: new Date().toISOString(), consumer: structuredClone(consumer) };
  }
  acceptUse(use: CredentialUse): void {
    const chain = this.usages.get(use.credentialId) ?? [];
    chain.push(structuredClone(use));
    this.usages.set(use.credentialId, chain);
  }
  list<TReq extends ScoutRequest>(request: TReq): readonly Credential<TReq>[] {
    return [...this.credentials.values()].filter((credential) =>
      credential.requestType === request.type && credential.workflowId === request.workflowId)
      .map((credential) => structuredClone(credential) as Credential<TReq>);
  }
  get<TReq extends ScoutRequest>(request: TReq, credentialId: string): Credential<TReq> | undefined {
    const credential = this.credentials.get(credentialId);
    if (!credential || credential.requestType !== request.type || credential.workflowId !== request.workflowId) return undefined;
    return structuredClone(credential) as Credential<TReq>;
  }
  uses(credentialId: string): readonly CredentialUse[] { return structuredClone(this.usages.get(credentialId) ?? []); }
}
