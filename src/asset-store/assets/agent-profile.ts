import { sha256Text, stableJson } from "../../core/fs.js";
import type { AgentProfile } from "../contracts/profile.js";

/** Returns the resource-bearing profile fields while excluding device root bindings. */
export function profileResourceProjection(profile: AgentProfile): Omit<
  AgentProfile,
  "readableRoots" | "writableRoots"
> {
  const { readableRoots: _readableRoots, writableRoots: _writableRoots, ...resources } = profile;
  return resources;
}

/** Hashes the resource-bearing profile fields while ignoring external root bindings. */
export function profileResourceHash(profile: AgentProfile): string {
  return sha256Text(stableJson(profileResourceProjection(profile)));
}
