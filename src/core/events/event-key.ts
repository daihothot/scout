/** Namespace accepted by the event route builder; domain scopes remain explicitly namespaced. */
export type EventKeyScope = "system" | "agent" | `domain.${string}`;

/** Declarative components from which a stable event route key is built. */
export interface EventKeyDefinition {
  scope: EventKeyScope;
  group: string;
  name: string;
  tag?: string;
}

/** Immutable event identity returned by the key factory, including its route string. */
export interface EventKey extends EventKeyDefinition {
  routeKey: string;
}

/** Factory boundary that validates, builds, and de-duplicates event identities. */
export interface EventKeyFactory {
  define(input: EventKeyDefinition): EventKey;
  build(input: EventKeyDefinition): string;
}

/** Creates a factory whose definitions cannot register the same route twice. */
export function createEventKeyFactory(): EventKeyFactory {
  const keys = new Set<string>();
  return {
    define(input) {
      const routeKey = buildEventRouteKey(input);
      if (keys.has(routeKey)) {
        throw new Error(`Duplicate event key: ${routeKey}`);
      }
      keys.add(routeKey);
      return Object.freeze({
        ...input,
        routeKey,
      });
    },
    build: buildEventRouteKey,
  };
}

/** Validates route components and joins them into the canonical dot-separated key. */
export function buildEventRouteKey(input: EventKeyDefinition): string {
  assertEventKeyPart("scope", input.scope);
  assertEventKeyPart("group", input.group);
  assertEventKeyPart("name", input.name);
  if (input.tag !== undefined) assertEventKeyPart("tag", input.tag);
  return [
    input.scope,
    input.group,
    input.name,
    input.tag,
  ].filter((part): part is string => typeof part === "string" && part.length > 0).join(".");
}

function assertEventKeyPart(field: string, value: string): void {
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(value)) {
    throw new Error(`Invalid event key ${field}: ${value}`);
  }
}
