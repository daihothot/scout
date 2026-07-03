import {
  createContextKeyFactory,
  type ContextKey,
  type ContextKeyDomain,
  type ContextKeyFactory,
} from "./context-key.js";

export interface ContextType<TValue = unknown> extends ContextKey {
  readonly kind: "context";
  readonly __value?: TValue;
}

export interface ContextScope {
  readonly kind: "scope";
  readonly domain: ContextKeyDomain;
  readonly scope: string;
  readonly routePrefix: string;
  includes(key: ContextKey): boolean;
}

export interface ContextDeclaration<TValue = unknown> {
  readonly tag?: string;
  readonly __contextDeclaration: true;
  readonly __value?: TValue;
}

export type ContextCatalogShape = {
  readonly [key: string]: ContextDeclaration | ContextCatalogShape;
};

export type DefinedContextCatalog<TCatalog extends ContextCatalogShape> = {
  readonly [K in keyof TCatalog]: TCatalog[K] extends ContextDeclaration<infer TValue>
    ? ContextType<TValue>
    : TCatalog[K] extends ContextCatalogShape
      ? ContextScope & DefinedContextCatalog<TCatalog[K]>
      : never;
};

export interface ContextCatalogRegistry<TDomain extends ContextKeyDomain> {
  readonly domain: TDomain;
  add<TCatalog extends ContextCatalogShape>(catalog: TCatalog): DefinedContextCatalog<TCatalog>;
}

const globalContextKeyFactory = createContextKeyFactory();

export function context<TValue = unknown>(input: {
  tag?: string;
} = {}): ContextDeclaration<TValue> {
  return Object.freeze({
    __contextDeclaration: true,
    tag: input.tag,
  });
}

export function defineContextCatalog<TCatalog extends ContextCatalogShape>(
  domain: ContextKeyDomain,
  catalog: TCatalog,
  input: {
    factory?: ContextKeyFactory;
  } = {},
): DefinedContextCatalog<TCatalog> {
  const factory = input.factory ?? globalContextKeyFactory;
  return defineCatalogNode({
    domain,
    node: catalog,
    path: [],
    factory,
  }) as DefinedContextCatalog<TCatalog>;
}

export function createContextCatalog<TDomain extends ContextKeyDomain>(
  domain: TDomain,
  input: {
    factory?: ContextKeyFactory;
  } = {},
): ContextCatalogRegistry<TDomain> {
  const factory = input.factory ?? globalContextKeyFactory;
  const root: Record<string, unknown> = {};
  return new Proxy(root, {
    get(target, property, receiver) {
      if (property === "domain") return domain;
      if (property === "add") {
        return <TCatalog extends ContextCatalogShape>(catalog: TCatalog): DefinedContextCatalog<TCatalog> => {
          const defined = defineContextCatalog(domain, catalog, { factory });
          mergeCatalog(target, defined as Record<string, unknown>);
          return defined;
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as ContextCatalogRegistry<TDomain>;
}

function mergeCatalog(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (!(key in target)) {
      target[key] = value;
      continue;
    }
    const targetValue = target[key];
    if (isMergeableCatalogNode(targetValue) && isMergeableCatalogNode(value)) {
      mergeCatalog(targetValue, value);
      continue;
    }
    throw new Error(`Duplicate context catalog property: ${key}`);
  }
}

function isMergeableCatalogNode(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && !("kind" in value && value.kind === "context");
}

function defineCatalogNode(input: {
  domain: ContextKeyDomain;
  node: ContextCatalogShape;
  path: string[];
  factory: ContextKeyFactory;
}): Record<string, unknown> {
  const output: Record<string, unknown> = input.path.length > 0
    ? defineContextScope({
      domain: input.domain,
      scope: toSnakeCase(input.path[0] ?? ""),
    })
    : {};
  for (const [propertyName, child] of Object.entries(input.node)) {
    const path = [...input.path, propertyName];
    if (isContextDeclaration(child)) {
      if (path.length < 2) {
        throw new Error(`Context catalog leaf ${path.join(".")} must include a scope and name.`);
      }
      output[propertyName] = defineContextType({
        domain: input.domain,
        scope: toSnakeCase(path[0] ?? ""),
        name: path.slice(1).map(toSnakeCase).join("_"),
        tag: child.tag,
        factory: input.factory,
      });
      continue;
    }
    output[propertyName] = defineCatalogNode({
      ...input,
      node: child,
      path,
    });
  }
  return Object.freeze(output);
}

function defineContextType(input: {
  domain: ContextKeyDomain;
  scope: string;
  name: string;
  tag?: string;
  factory: ContextKeyFactory;
}): ContextType {
  const key = input.factory.define({
    domain: input.domain,
    scope: input.scope,
    name: input.name,
    tag: input.tag,
  });
  const type: ContextType = {
    kind: "context",
    ...key,
  };
  return Object.freeze(type);
}

function defineContextScope(input: {
  domain: ContextKeyDomain;
  scope: string;
}): ContextScope & Record<string, unknown> {
  const routePrefix = `${input.domain}.${input.scope}.`;
  return {
    kind: "scope",
    domain: input.domain,
    scope: input.scope,
    routePrefix,
    includes(key) {
      return key.routeKey.startsWith(routePrefix);
    },
  };
}

function isContextDeclaration(value: ContextDeclaration | ContextCatalogShape): value is ContextDeclaration {
  return "__contextDeclaration" in value;
}

function toSnakeCase(value: string): string {
  return value
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replaceAll(/[-\s]+/g, "_")
    .toLowerCase();
}
