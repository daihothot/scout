import {
  BaseDomain,
  createDomainRuntime,
  isScoutDomainId,
  ScoutDomainId,
  type ScoutDomain,
} from "../../../domain/index.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

/** Creates, installs, starts, and disposes the Domains selected by the Workflow. */
export class DomainStage implements RunStage {
  readonly id = "domain";
  private started = false;
  private cleanupPending = false;

  async start(): Promise<void> {
    if (this.started) return;
    const scope = currentRunScope();
    if (scope.domainRegistry.list().length > 0) {
      throw new Error("Cannot start Domains while registered runtimes still require cleanup.");
    }
    const selectedDomainId = scope.workflow.graph.snapshot().domain;
    if (!isScoutDomainId(selectedDomainId) || selectedDomainId === ScoutDomainId.Base) {
      throw new Error("Workflow domain must be one specialized Domain id; Base is installed automatically.");
    }
    const registered: ScoutDomain[] = [];
    try {
      registered.push(scope.domainRegistry.register(new BaseDomain()));
      this.cleanupPending = true;
      registered.push(scope.domainRegistry.register(await createDomainRuntime(selectedDomainId)));
      for (const domain of scope.domainRegistry.list()) {
        await domain.start?.();
        scope.workflow.registerParticipant(domain);
      }
      this.started = true;
    } catch (error) {
      const failures: unknown[] = [error];
      for (const domain of [...registered].reverse()) {
        try {
          await domain.stop?.();
          if (scope.workflow.participants.includes(domain)) scope.workflow.unregisterParticipant(domain);
          scope.domainRegistry.unregister(domain);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      this.cleanupPending = scope.domainRegistry.list().length > 0;
      if (failures.length > 1) throw new AggregateError(failures, "Domain startup and cleanup failed; unreleased Domains remain registered.");
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started && !this.cleanupPending) return;
    this.started = false;
    const scope = currentRunScope();
    const domains = scope.domainRegistry.list().reverse();
    if (domains.length === 0) {
      this.cleanupPending = false;
      return;
    }
    const failures: unknown[] = [];
    try {
      await scope.workflow.quiesce();
    } catch (error) {
      // A failed transition is settled before any Domain resources are closed.
      failures.push(error);
    }
    for (const domain of domains) {
      try {
        await domain.stop?.();
        if (scope.workflow.participants.includes(domain)) scope.workflow.unregisterParticipant(domain);
        scope.domainRegistry.unregister(domain);
      } catch (error) {
        failures.push(error);
      }
    }
    this.cleanupPending = scope.domainRegistry.list().length > 0;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Domain cleanup failed; unreleased Domains remain registered.");
  }
}
