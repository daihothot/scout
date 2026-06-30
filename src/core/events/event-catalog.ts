import type { ScoutEvent } from "./event-bus.js";
import {
  createEventKeyFactory,
  type EventKey,
  type EventKeyFactory,
  type EventKeyScope,
} from "./event-key.js";

export interface EventType<TPayload = unknown> extends EventKey {
  readonly kind: "event";
  is(event: ScoutEvent): boolean;
}

export interface EventGroup {
  readonly kind: "group";
  readonly scope: EventKeyScope;
  readonly group: string;
  readonly routePrefix: string;
  is(event: ScoutEvent): boolean;
}

export interface EventDeclaration<TPayload = unknown> {
  readonly tag?: string;
  readonly __eventDeclaration: true;
  readonly __payload?: TPayload;
}

export type EventCatalogShape = {
  readonly [key: string]: EventDeclaration | EventCatalogShape;
};

export type DefinedEventCatalog<TCatalog extends EventCatalogShape> = {
  readonly [K in keyof TCatalog]: TCatalog[K] extends EventDeclaration<infer TPayload>
    ? EventType<TPayload>
    : TCatalog[K] extends EventCatalogShape
      ? EventGroup & DefinedEventCatalog<TCatalog[K]>
      : never;
};

const globalEventKeyFactory = createEventKeyFactory();

export function event<TPayload = unknown>(input: {
  tag?: string;
} = {}): EventDeclaration<TPayload> {
  return Object.freeze({
    __eventDeclaration: true,
    tag: input.tag,
  });
}

export function defineEventCatalog<TCatalog extends EventCatalogShape>(
  scope: EventKeyScope,
  catalog: TCatalog,
  input: {
    factory?: EventKeyFactory;
  } = {},
): DefinedEventCatalog<TCatalog> {
  const factory = input.factory ?? globalEventKeyFactory;
  return defineCatalogNode({
    scope,
    node: catalog,
    path: [],
    factory,
  }) as DefinedEventCatalog<TCatalog>;
}

function defineCatalogNode(input: {
  scope: EventKeyScope;
  node: EventCatalogShape;
  path: string[];
  factory: EventKeyFactory;
}): Record<string, unknown> {
  const output: Record<string, unknown> = input.path.length > 0
    ? defineEventGroup({
      scope: input.scope,
      group: toSnakeCase(input.path[0] ?? ""),
    })
    : {};
  for (const [propertyName, child] of Object.entries(input.node)) {
    const path = [...input.path, propertyName];
    if (isEventDeclaration(child)) {
      if (path.length < 2) {
        throw new Error(`Event catalog leaf ${path.join(".")} must include a group and name.`);
      }
      output[propertyName] = defineEventType({
        scope: input.scope,
        group: toSnakeCase(path[0] ?? ""),
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

function defineEventType(input: {
  scope: EventKeyScope;
  group: string;
  name: string;
  tag?: string;
  factory: EventKeyFactory;
}): EventType {
  const key = input.factory.define({
    scope: input.scope,
    group: input.group,
    name: input.name,
    tag: input.tag,
  });
  const type: EventType = {
    kind: "event",
    ...key,
    is(event) {
      return event.key.routeKey === type.routeKey;
    },
  };
  return Object.freeze(type);
}

function defineEventGroup(input: {
  scope: EventKeyScope;
  group: string;
}): EventGroup & Record<string, unknown> {
  const routePrefix = `${input.scope}.${input.group}.`;
  return {
    kind: "group",
    scope: input.scope,
    group: input.group,
    routePrefix,
    is(event) {
      return event.key.routeKey.startsWith(routePrefix);
    },
  };
}

function isEventDeclaration(value: EventDeclaration | EventCatalogShape): value is EventDeclaration {
  return "__eventDeclaration" in value;
}

function toSnakeCase(value: string): string {
  return value
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replaceAll(/[-\s]+/g, "_")
    .toLowerCase();
}
