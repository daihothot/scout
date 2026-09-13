/** Runtime Behavioral Test domain lifecycle and campaign facts. */
export * from "./rbt-domain.js";
export * from "./rbt-events.js";
export * from "./core/index.js";
export * from "./agent/index.js";

import type { ScoutDomain } from "../types.js";
import { RbtDomain } from "./rbt-domain.js";

/** Creates one RBT Domain instance for the current run scope. */
export function createDomain(): ScoutDomain {
  return new RbtDomain();
}
