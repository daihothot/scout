import type {
  AssetStore,
  MountPreparationInspection,
} from "../../asset-store/index.js";
import {
  type EnvironmentRolePlan,
  type EnvironmentRolePreparationInput,
} from "./types.js";

/**
 * Adds an immutable inspection result to the role inputs assembled by a
 * lifecycle stage. It deliberately does not publish progress or mutate a
 * mount; `prepareMount` is a separate runner step so the inspect/prepare
 * decision remains frozen and can be checked again by the asset store.
 */
export class EnvironmentRolePlanner {
  constructor(
    private readonly assetStore: Pick<AssetStore, "inspectMount">,
  ) {}

  plan(
    inputs: readonly EnvironmentRolePreparationInput[],
  ): EnvironmentRolePlan[] {
    return inputs.map((input) => {
      let inspection: MountPreparationInspection;
      try {
        inspection = this.assetStore.inspectMount(input.options);
      } catch (error) {
        throw new EnvironmentRolePlanningError(input.role, error);
      }
      return {
        ...input,
        inspection,
      };
    });
  }
}

/** Identifies the role whose mount inspection failed before execution began. */
export class EnvironmentRolePlanningError extends Error {
  readonly role: EnvironmentRolePreparationInput["role"];

  constructor(role: EnvironmentRolePreparationInput["role"], cause: unknown) {
    super(`Failed to inspect environment mount for ${role}: ${errorText(cause)}`, { cause });
    this.name = "EnvironmentRolePlanningError";
    this.role = role;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
