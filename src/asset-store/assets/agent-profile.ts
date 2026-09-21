import { sha256Text, stableJson } from "../../core/fs.js";
import type { AgentProfile } from "../contracts/profile.js";

/** Returns resource-bearing fields while excluding runtime model and device root bindings. */
export function profileResourceProjection(profile: AgentProfile): Omit<
  AgentProfile,
  "model" | "readableRoots" | "writableRoots"
> {
  const {
    model: _model,
    readableRoots: _readableRoots,
    writableRoots: _writableRoots,
    ...resources
  } = profile;
  return resources;
}

/** Hashes the resource-bearing profile fields while ignoring external root bindings. */
export function profileResourceHash(profile: AgentProfile): string {
  return sha256Text(stableJson(profileResourceProjection(profile)));
}
