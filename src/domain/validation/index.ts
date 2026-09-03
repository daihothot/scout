/** Validation domain lifecycle, events, and agent backend boundary. */
export * from "./agent/backend/index.js";
export * from "./domain.js";
export * from "./validation-events.js";

import type { ScoutDomain } from "../types.js";
import { ValidationDomain } from "./domain.js";

/** Creates one Validation Domain instance for the current run scope. */
export function createDomain(): ScoutDomain {
  return new ValidationDomain();
}
