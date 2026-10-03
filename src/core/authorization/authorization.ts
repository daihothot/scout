import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { currentRunScope } from "../../run/run-scope.js";
import { EventSubscriptionPriorities, type EventType } from "../events/index.js";
import type { ScoutWorkflowParticipant, WorkflowData } from "../workflow/index.js";
import { ApprovalCenter } from "./approval/approval-center.js";
import { ApprovalEvents } from "./approval/approval-events.js";
import { ApprovalProjector } from "./approval/projector/approval-projector.js";
import type { ApprovalSubmission, ApprovalResult } from "./approval/types.js";
import { CredentialChain } from "./credential/credential-chain.js";
import { CredentialEvents } from "./credential/credential-events.js";
import { CredentialProjector } from "./credential/projector/credential-projector.js";
import { AuthorizationRecordObject } from "./record/authorization-record-object.js";
import type { ScoutRequestRecord } from "./record/authorization-record.js";
import { RequestProjector } from "./request/projector/request-projector.js";
import { RequestHub } from "./request/request-hub.js";
import { RequestEvents } from "./request/request-events.js";
import type { RequestType, RequestRegistration, ScoutRequest } from "./request/types.js";

/** Sole authorization entry point, Workflow owner and request/approval/credential orchestrator. */
export class Authorization implements ScoutWorkflowParticipant {
  private readonly contracts = new Map<string, RequestType<ScoutRequest>>();
  private readonly recordObject = new AuthorizationRecordObject(this.contracts);
  private readonly requestHub = new RequestHub(this.contracts);
  private readonly credentialChain = new CredentialChain();
  private readonly approvalCenter = new ApprovalCenter();
  private started = false;
  private closed = false;
  private pending = Promise.resolve();

  start(): void {
    if (this.closed) throw new Error("Authorization is closed.");
    if (this.started) return;
    this.recordObject.start();
    this.requestHub.start();
    this.approvalCenter.start();
    this.started = true;
  }
  stop(): void {
    this.closed = true;
    const failures: unknown[] = [];
    try { this.approvalCenter.stop(); } catch (error) { failures.push(error); }
    try { this.requestHub.stop(); } catch (error) { failures.push(error); }
    try { this.recordObject.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Authorization cleanup failed.");
  }

  registerRequestType<TReq extends ScoutRequest, TRecord extends ScoutRequestRecord>(type: RequestType<TReq, TRecord>): void {
    this.requestHub.bind(type);
  }
  async register<TReq extends ScoutRequest, TRecord extends ScoutRequestRecord>(
    type: RequestType<TReq, TRecord>, input: NoInfer<RequestRegistration<TReq>>,
  ): Promise<TReq> {
    const request = this.requestHub.register(type, input, this.activeWorkflowId());
    await this.commit(RequestEvents.authorizationRequest.registered, { request: { ...request, state: { status: "active" } } },
      { id: randomUUID(), occurredAt: request.createdAt }, () => this.requestHub.accept(request));
    return this.get(type, request.requestId)!;
  }
  get<TReq extends ScoutRequest, TRecord extends ScoutRequestRecord>(type: RequestType<TReq, TRecord>, requestId: string): TReq | undefined {
    return this.requestHub.get(type, requestId);
  }
  find(requestId: string): ScoutRequest | undefined { return this.requestHub.find(requestId); }

  submit<TReq extends ScoutRequest>(request: TReq, submission: NoInfer<ApprovalSubmission<TReq>>): Promise<ApprovalResult<TReq>> {
    const candidate = structuredClone(submission);
    const requestIdentity = structuredClone(request);
    const operation = this.pending.then(async () => {
      const workflowId = this.activeWorkflowId();
      const registered = this.requestHub.require(requestIdentity);
      if (registered.state.status === "expired") throw new Error("Request is expired.");
      if (registered.workflowId !== workflowId) throw new Error("Request is not active in this Workflow.");
      if (candidate.result.decision === "approved") {
        const result = candidate.result;
        if (!registered.allowedGrants.some((grant) => isDeepStrictEqual(grant.scope, result.scope)
          && isDeepStrictEqual(grant.target, result.target))) throw new Error("Approval grant is not registered.");
        const credential = this.credentialChain.match(registered, result);
        if (credential) {
          const use = this.credentialChain.use(credential, registered, candidate.consumer);
          await this.commit(CredentialEvents.authorizationCredential.used, { ...use },
            { id: use.approvalId, occurredAt: use.usedAt }, () => this.credentialChain.acceptUse(use));
          return structuredClone({ decision: "approved" as const, scope: credential.scope, target: credential.target });
        }
      }
      const approval = this.approvalCenter.submit(registered, candidate);
      await this.commit(ApprovalEvents.authorizationApproval.submitted, { ...approval },
        { id: approval.approvalId, occurredAt: approval.submittedAt }, () => {
          this.approvalCenter.accept(approval);
          if (approval.result.decision === "approved") {
            const credential = this.credentialChain.issue({ ...approval, result: approval.result, basis: { kind: "new" } });
            currentRunScope().eventBus.publish(CredentialEvents.authorizationCredential.issued,
              { ...credential }, { occurredAt: credential.issuedAt });
          }
        });
      return structuredClone(approval.result);
    });
    // Keep the queue available after a rejected mutation, without hiding that rejection from its caller.
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  approvals<TReq extends ScoutRequest>(request: TReq) { return this.approvalCenter.list(request); }
  consumed(request: ScoutRequest): number { return this.approvalCenter.consumed(request); }
  credentials<TReq extends ScoutRequest>(request: TReq) { return this.credentialChain.list(request); }
  credential<TReq extends ScoutRequest>(request: TReq, credentialId: string) { return this.credentialChain.get(request, credentialId); }
  credentialUses(credentialId: string) { return this.credentialChain.uses(credentialId); }

  expire(requestId: string, reason: string): Promise<boolean> {
    const operation = this.pending.then(async () => {
      this.assertStarted();
      const request = this.requestHub.find(requestId);
      if (!request || request.state.status !== "active") return false;
      if (request.workflowId !== currentRunScope().workflow.snapshot()?.workflowId) {
        throw new Error("Cannot expire a request in a different Workflow record.");
      }
      const occurredAt = new Date().toISOString();
      await this.commit(RequestEvents.authorizationRequest.expired,
        { requestId, workflowId: request.workflowId, reason },
        { id: randomUUID(), occurredAt }, () => this.requestHub.expire(requestId, reason, occurredAt));
      return true;
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  create(): void {
    this.requestHub.clearWorkflow(); this.approvalCenter.clearWorkflow(); this.credentialChain.clearWorkflow();
  }
  restore(data: WorkflowData): void {
    if (data.status === "completed") return;
    this.recordObject.attach(currentRunScope().workflow.journalRoot);
    const records = this.recordObject.read();
    const requests = new RequestProjector(this.contracts).project(records, data.workflowId);
    const approvals = new ApprovalProjector().project(records, data.workflowId);
    const credentials = new CredentialProjector().project(records, data.workflowId);
    // Aggregate only after every projection has succeeded.
    this.requestHub.restore(requests);
    this.approvalCenter.restore(approvals);
    this.credentialChain.restore(credentials);
  }
  run(): void {}
  async close(): Promise<void> {
    await this.pending;
    for (const request of this.requestHub.list()) {
      if (request.state.status === "active") await this.expire(request.requestId, "workflow_completed");
    }
  }
  async abort(): Promise<void> { await this.pending; }
  clearWorkflow(): void {
    this.create();
    this.recordObject.release();
  }

  private activeWorkflowId(): string {
    this.assertStarted();
    const workflow = currentRunScope().workflow.snapshot();
    if (!workflow || workflow.status !== "active") throw new Error("Authorization requires an active Workflow.");
    return workflow.workflowId;
  }
  private assertStarted(): void {
    if (this.closed) throw new Error("Authorization is closed.");
    if (!this.started) throw new Error("Authorization is not started.");
  }

  /** Wait for required recording and owned runtime application, not unrelated observers. */
  private commit<T>(
    type: EventType<T>, payload: NoInfer<T>, identity: { id: string; occurredAt: string }, apply: () => void,
  ): Promise<void> {
    const scope = currentRunScope();
    return new Promise<void>((resolve, reject) => {
      const unsubscribe = scope.eventBus.subscribe(type, (event) => {
        if (event.id !== identity.id) return;
        unsubscribe();
        apply();
        resolve();
      }, { priority: EventSubscriptionPriorities.Normal });
      void scope.eventBus.publishAndWait(type, structuredClone(payload), identity).catch((error) => {
        unsubscribe();
        reject(error); // Has no effect after required consumption has already succeeded.
        try {
          scope.logger.error({ module: "authorization", event: "event_consumption_failed",
            message: error instanceof Error ? error.stack ?? error.message : String(error),
            data: { eventId: identity.id, routeKey: type.routeKey } });
        } catch { /* Disclosure cannot replace the mutation's result. */ }
      });
    });
  }
}
