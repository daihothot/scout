export type EventKeyScope = "system" | `domain.${string}`;

export interface EventKeyDefinition {
  scope: EventKeyScope;
  group: string;
  name: string;
  tag?: string;
}

export interface EventKey extends EventKeyDefinition {
  routeKey: string;
}

export interface EventKeyFactory {
  define(input: EventKeyDefinition): EventKey;
  build(input: EventKeyDefinition): string;
}

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
