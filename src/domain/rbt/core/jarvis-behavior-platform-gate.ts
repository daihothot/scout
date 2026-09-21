import type {
  ExecutionPlatformIdentity,
} from "../../../execution/index.js";
import { currentRunScope } from "../../../run/run-scope.js";

export type PlatformRunResult =
  | { ok: true; platform: ExecutionPlatformIdentity }
  | { ok: false; code: string; message: string };

/** Gates RBT work on an identified and ready execution platform. */
export class JarvisBehaviorPlatformGate {
  async ensure(): Promise<PlatformRunResult> {
    const launched = await currentRunScope().executionSystem.launch();
    return launched.ok
      ? { ok: true, platform: launched.identity }
      : launched;
  }
}
