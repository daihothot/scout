import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MountManifest } from "../contracts/manifest.js";

/** Read-only filesystem result for the mount manifest path. */
export type MountManifestFileReadResult =
  | { status: "present"; path: string; manifest: MountManifest }
  | { status: "absent"; path: string }
  | { status: "invalid"; path: string; reason: string };

/** Reads the mount manifest without treating malformed or unsafe files as usable state. */
export function readMountManifestFile(mountRoot: string): MountManifestFileReadResult {
  const path = join(mountRoot, "mount-manifest.json");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent", path };
    return {
      status: "invalid",
      path,
      reason: `manifest metadata read failed: ${describeFileError(error)}`,
    };
  }
  if (stat.isSymbolicLink()) {
    return { status: "invalid", path, reason: "manifest path is a symbolic link" };
  }
  if (!stat.isFile()) {
    return { status: "invalid", path, reason: "manifest path is not a regular file" };
  }

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    return {
      status: "invalid",
      path,
      reason: `manifest content read failed: ${describeFileError(error)}`,
    };
  }
  try {
    return { status: "present", path, manifest: JSON.parse(content) as MountManifest };
  } catch (error) {
    return {
      status: "invalid",
      path,
      reason: `manifest JSON parse failed: ${describeFileError(error)}`,
    };
  }
}

function describeFileError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  const message = error instanceof Error ? error.message : String(error);
  return code ? `${code}: ${message}` : message;
}
