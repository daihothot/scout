/** Domain contracts and the dynamic Domain creation entry exposed to run stages. */
export * from "./types.js";

import type { ScoutDomain } from "./types.js";

/**
 * Creates the Domain selected by GraphState through its conventional module entry.
 * A Domain named <domain> is loaded from domain/<domain>/index.js.
 */
export async function createDomainRuntime(domainId: string): Promise<ScoutDomain> {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(domainId)) {
    throw new Error(`Invalid Workflow domain: ${domainId}`);
  }

  let domainModule: unknown;
  try {
    domainModule = await import(`./${domainId}/index.js`);
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
    || typeof (domain as ScoutDomain).domainId !== "string"
    || typeof (domain as ScoutDomain).name !== "string"
    || typeof (domain as ScoutDomain).dynamicToolsForRole !== "function"
    || (domain as ScoutDomain).domainId !== domainId
  ) {
    throw new Error(`Workflow domain ${domainId} returned an invalid Domain instance.`);
  }
  const candidate = domain as ScoutDomain;
  if (
    (candidate.handleDynamicToolCall !== undefined
      && typeof candidate.handleDynamicToolCall !== "function")
    || (candidate.restore !== undefined && typeof candidate.restore !== "function")
    || (candidate.start !== undefined && typeof candidate.start !== "function")
    || (candidate.stop !== undefined && typeof candidate.stop !== "function")
  ) {
    throw new Error(`Workflow domain ${domainId} returned an invalid Domain instance.`);
  }
  const journal = candidate.journal;
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
    )
  ) {
    throw new Error(`Workflow domain ${domainId} returned an invalid Domain journal.`);
  }
  return candidate;
}
