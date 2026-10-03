import { randomUUID } from "node:crypto";
import type { ScoutRequest } from "../request/types.js";
import type { Approval, ApprovalSubmission } from "./types.js";

/** Handles new decisions and their allowance; credential-backed grants belong to Authorization. */
export class ApprovalCenter {
  private readonly approvals = new Map<string, Approval>();
  private started = false;
  private closed = false;

  start(): void {
    if (this.closed) throw new Error("ApprovalCenter is closed.");
    this.started = true;
  }
  restore(runtimeObjects: readonly Approval[]): void {
    this.approvals.clear();
    for (const approval of runtimeObjects) this.approvals.set(approval.approvalId, approval);
  }
  clearWorkflow(): void { this.approvals.clear(); }

  submit<TReq extends ScoutRequest>(request: TReq, submission: NoInfer<ApprovalSubmission<TReq>>): Approval<TReq> {
    if (this.closed) throw new Error("ApprovalCenter is closed.");
    if (!this.started) throw new Error("ApprovalCenter is not started.");
    const result = submission.result.decision === "approved" && this.consumed(request) >= request.maxConsumptions
      ? { decision: "denied" as const, reason: "Request approval allowance is exhausted." }
      : submission.result;
    const identity = { approvalId: randomUUID(), requestId: request.requestId, requestType: request.type,
      workflowId: request.workflowId, submittedAt: new Date().toISOString(),
      consumer: structuredClone(submission.consumer) };
    return result.decision === "approved"
      ? { ...identity, result: structuredClone(result), basis: { kind: "new" } }
      : { ...identity, result: structuredClone(result), basis: { kind: "denied" } };
  }
  accept(approval: Approval): void { this.approvals.set(approval.approvalId, structuredClone(approval)); }
  list<TReq extends ScoutRequest>(request: TReq): readonly Approval<TReq>[] {
    return [...this.approvals.values()].filter((approval) => approval.requestId === request.requestId
      && approval.requestType === request.type && approval.workflowId === request.workflowId)
      .map((approval) => structuredClone(approval) as Approval<TReq>);
  }
  consumed(request: ScoutRequest): number { return this.list(request).filter((approval) => approval.result.decision === "approved").length; }
  stop(): void { this.closed = true; }
}
