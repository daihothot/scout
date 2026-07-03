export type ContextKeyDomain = string;

export interface ContextKeyDefinition {
  domain: ContextKeyDomain;
  scope: string;
  name: string;
  tag?: string;
}

export interface ContextKey extends ContextKeyDefinition {
  routeKey: string;
}

export interface ContextKeyFactory {
  define(input: ContextKeyDefinition): ContextKey;
  build(input: ContextKeyDefinition): string;
}

export function createContextKeyFactory(): ContextKeyFactory {
  const keys = new Set<string>();
  return {
    define(input) {
      const routeKey = buildContextRouteKey(input);
      if (keys.has(routeKey)) {
        throw new Error(`Duplicate context key: ${routeKey}`);
      }
      keys.add(routeKey);
      return Object.freeze({
        ...input,
        routeKey,
      });
    },
    build: buildContextRouteKey,
  };
}

export function buildContextRouteKey(input: ContextKeyDefinition): string {
  assertContextKeyPart("domain", input.domain);
  assertContextKeyPart("scope", input.scope);
  assertContextKeyPart("name", input.name);
  if (input.tag !== undefined) assertContextKeyPart("tag", input.tag);
  return [
    input.domain,
    input.scope,
    input.name,
    input.tag,
  ].filter((part): part is string => typeof part === "string" && part.length > 0).join(".");
}

function assertContextKeyPart(field: string, value: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid context key ${field}: ${value}`);
  }
}
