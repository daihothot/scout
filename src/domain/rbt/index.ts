/** Runtime Behavioral Test domain lifecycle and campaign facts. */
export * from "./domain.js";
export * from "./rbt-events.js";

import type { ScoutDomain } from "../types.js";
import { RbtDomain } from "./domain.js";

/** Creates one RBT Domain instance for the current run scope. */
export function createDomain(): ScoutDomain {
  return new RbtDomain();
}
