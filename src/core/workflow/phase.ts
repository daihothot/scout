import type { GraphPhase } from "./graph-state.js";

/** Current Worker Phase that selects the first available bound role. */
export class Phase {
  readonly name: string;
  private readonly roleNames: readonly string[];

  constructor(state: GraphPhase) {
    this.name = state.name;
    this.roleNames = Object.freeze([...state.roles]);
  }

  /** Returns the first bound role that the runtime reports as available. */
  selectAvailableRole(isAvailable: (role: string) => boolean): string | undefined {
    return this.roleNames.find(isAvailable);
  }
}
