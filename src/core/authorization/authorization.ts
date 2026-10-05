import { randomUUID } from "node:crypto";
import { currentRunScope } from "../../run/run-scope.js";
import { EventSubscriptionPriorities, type EventType } from "../events/index.js";
import type { ScoutWorkflowParticipant, WorkflowData } from "../workflow/index.js";
import { ApprovalCenter } from "./approval/approval-center.js";
import { ApprovalEvents } from "./approval/approval-events.js";
import { ApprovalProjector } from "./approval/projector/approval-projector.js";
import type { ApprovalResult } from "./approval/types.js";
import { CredentialChain } from "./credential/credential-chain.js";
import { CredentialEvents } from "./credential/credential-events.js";
import { CredentialProjector } from "./credential/projector/credential-projector.js";
import { AuthorizationRecordObject } from "./record/authorization-record-object.js";
import type { ScoutRequestSourceRecord } from "./record/authorization-record.js";
import { RequestSourceProjector } from "./request-source/projector/request-source-projector.js";
import { RequestSourceHub } from "./request-source/request-source-hub.js";
import { RequestSourceEvents } from "./request-source/request-source-events.js";
import type { RequestSourceType, SourceRegistration, ScoutRequestSource } from "./request-source/types.js";
import { RequestSourceMatching } from "./request-source/matching/request-source-matching.js";
import type { ScoutRequest } from "./types.js";

/** Sole authorization entry point, Workflow owner and request/approval/credential orchestrator. */
export class Authorization implements ScoutWorkflowParticipant {
  private readonly contracts = new Map<string, RequestSourceType<ScoutRequestSource>>();
  private readonly recordObject = new AuthorizationRecordObject(this.contracts);
  private readonly requestHub = new RequestSourceHub(this.contracts);
  private readonly matching = new RequestSourceMatching(this.requestHub);
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

  registerRequestSourceType<TReq extends ScoutRequestSource, TRecord extends ScoutRequestSourceRecord>(type: RequestSourceType<TReq, TRecord>): void {
    this.requestHub.bind(type);
  }
  register<TReq extends ScoutRequestSource, TRecord extends ScoutRequestSourceRecord>(
    type: RequestSourceType<TReq, TRecord>, input: NoInfer<SourceRegistration<TReq>>,
  ): Promise<TReq> {
    const registration = structuredClone(input);
    const operation = this.pending.then(async () => {
      const source = this.requestHub.register(type, registration, this.activeWorkflowId());
      if (this.requestHub.find(source.sourceId)) return source;
      await this.commit(RequestSourceEvents.authorizationRequestSource.registered, { source: { ...source, state: { status: "active" } } },
        { id: randomUUID(), occurredAt: source.createdAt }, () => this.requestHub.accept(source));
      return this.get(type, source.sourceId)!;
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
  get<TReq extends ScoutRequestSource, TRecord extends ScoutRequestSourceRecord>(type: RequestSourceType<TReq, TRecord>, sourceId: string): TReq | undefined {
    return this.requestHub.get(type, sourceId);
  }
  sources<TReq extends ScoutRequestSource, TRecord extends ScoutRequestSourceRecord>(type: RequestSourceType<TReq, TRecord>): readonly TReq[] {
    return this.requestHub.ofType(type);
  }
  find(sourceId: string): ScoutRequestSource | undefined { return this.requestHub.find(sourceId); }

  submit<TSource extends ScoutRequestSource, TRecord extends ScoutRequestSourceRecord, TRequest extends ScoutRequest>(
    type: RequestSourceType<TSource, TRecord, TRequest>, request: NoInfer<TRequest>,
  ): Promise<ApprovalResult<TSource>> {
    const application = structuredClone(request);
    const operation = this.pending.then(async () => {
      const workflowId = this.activeWorkflowId();
      if (application.workflowId !== workflowId) throw new Error("Application is not in the active Workflow.");
      const candidates = this.matching.match(type, application);
      if (!candidates.length) return { decision: "denied" as const, reason: "No matching active request source." };
      for (const { source, grant } of candidates) {
        const credential = this.credentialChain.match(source, grant);
        if (!credential) continue;
        const use = this.credentialChain.use(credential, source, application.consumer);
        await this.commit(CredentialEvents.authorizationCredential.used, { ...use },
          { id: use.approvalId, occurredAt: use.usedAt }, () => this.credentialChain.acceptUse(use));
        return structuredClone({ decision: "approved" as const, scope: credential.scope, target: credential.target });
      }
      const available = candidates.find(({ source }) => source.maxApprovals === null
        || this.approvalCenter.consumed(source) < source.maxApprovals);
      const selected = available ?? candidates[0]!;
      const approval = this.approvalCenter.submit(selected.source, {
        consumer: application.consumer, result: { decision: "approved", ...selected.grant },
      });
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
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
  approvals<TReq extends ScoutRequestSource>(request: TReq) { return this.approvalCenter.list(request); }
  consumed(request: ScoutRequestSource): number { return this.approvalCenter.consumed(request); }
  credentials<TReq extends ScoutRequestSource>(request: TReq) { return this.credentialChain.list(request); }
  credential<TReq extends ScoutRequestSource>(request: TReq, credentialId: string) { return this.credentialChain.get(request, credentialId); }
  credentialUses(credentialId: string) { return this.credentialChain.uses(credentialId); }

  expire(sourceId: string, reason: string): Promise<boolean> {
    const operation = this.pending.then(async () => {
      this.assertStarted();
      const request = this.requestHub.find(sourceId);
      if (!request || request.state.status !== "active") return false;
      if (request.workflowId !== currentRunScope().workflow.snapshot()?.workflowId) {
        throw new Error("Cannot expire a request in a different Workflow record.");
      }
      const occurredAt = new Date().toISOString();
      await this.commit(RequestSourceEvents.authorizationRequestSource.expired,
        { sourceId, workflowId: request.workflowId, reason },
        { id: randomUUID(), occurredAt }, () => this.requestHub.expire(sourceId, reason, occurredAt));
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
    const requests = new RequestSourceProjector(this.contracts).project(records, data.workflowId);
    const approvals = new ApprovalProjector(this.contracts).project(records, data.workflowId);
    const credentials = new CredentialProjector(this.contracts).project(records, data.workflowId);
    // Aggregate only after every projection has succeeded.
    this.requestHub.restore(requests);
    this.approvalCenter.restore(approvals);
    this.credentialChain.restore(credentials);
  }
  run(): void {}
  async close(): Promise<void> {
    await this.pending;
    for (const request of this.requestHub.list()) {
      if (request.state.status === "active") await this.expire(request.sourceId, "workflow_completed");
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
