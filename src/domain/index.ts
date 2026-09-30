/** Domain contracts and the dynamic Domain creation entry exposed to run stages. */
export * from "./types.js";
export * from "./domain-events.js";
export * from "./domain-registry.js";
export * from "./agent/index.js";
export * from "./core/record/index.js";
export * from "./core/benchmarks/index.js";
export * from "./domains/base/index.js";

import { DomainAgentBackend } from "./agent/index.js";
import {
  isScoutDomainId,
  type ScoutDomain,
  type ScoutDomainId,
} from "./types.js";

/**
 * Creates the Domain selected by GraphState through its conventional module entry.
 * A Domain named <domain> is loaded from domain/domains/<domain>/index.js.
 */
export async function createDomainRuntime(domainId: ScoutDomainId): Promise<ScoutDomain> {
  if (!isScoutDomainId(domainId)) {
    throw new Error(`Invalid Workflow domain: ${domainId}`);
  }

  let domainModule: unknown;
  try {
    domainModule = await import(`./domains/${domainId}/index.js`);
  } catch (error) {
    throw new Error(`Cannot load Workflow domain: ${domainId}`, { cause: error });
  }
  if (
    typeof domainModule !== "object"
    || domainModule === null
    || !("createDomain" in domainModule)
    || typeof domainModule.createDomain !== "function"
  ) {
    throw new Error(
      `Workflow domain ${domainId} must export a createDomain function.`,
    );
  }

  const domain: unknown = domainModule.createDomain();
  if (
    typeof domain !== "object"
    || domain === null
    || typeof (domain as ScoutDomain).description !== "object"
    || (domain as ScoutDomain).description === null
    || !isScoutDomainId((domain as ScoutDomain).description.id)
    || typeof (domain as ScoutDomain).description.name !== "string"
    || (domain as ScoutDomain).description.id !== domainId
  ) {
    throw new Error(`Workflow domain ${domainId} returned an invalid Domain instance.`);
  }
  const candidate = domain as ScoutDomain;
  if (
    (candidate.restore !== undefined && typeof candidate.restore !== "function")
    || (candidate.start !== undefined && typeof candidate.start !== "function")
    || (candidate.stop !== undefined && typeof candidate.stop !== "function")
  ) {
    throw new Error(`Workflow domain ${domainId} returned an invalid Domain instance.`);
  }
  const backend = candidate.backend;
  if (
    !(backend instanceof DomainAgentBackend)
    || typeof backend.register !== "function"
    || typeof backend.unregister !== "function"
    || typeof backend.dynamicToolsForPhase !== "function"
    || typeof backend.handleDynamicToolCall !== "function"
  ) {
    throw new Error(`Workflow domain ${domainId} returned an invalid Domain backend.`);
  }
  const journal = candidate.recordObject;
  if (
    journal !== undefined
    && (
      typeof journal !== "object"
      || journal === null
      || !Array.isArray(journal.eventTypes)
      || !journal.eventTypes.every((eventType) => (
        typeof eventType === "object"
        && eventType !== null
        && (eventType as { kind?: unknown }).kind === "event"
        && typeof (eventType as { routeKey?: unknown }).routeKey === "string"
        && typeof (eventType as { is?: unknown }).is === "function"
      ))
      || typeof journal.project !== "function"
      || (journal.readAll !== undefined && typeof journal.readAll !== "function")
      || (journal.aggregate !== undefined && typeof journal.aggregate !== "function")
    )
  ) {
    throw new Error(`Workflow domain ${domainId} returned an invalid Domain journal.`);
  }
  return candidate;
}
