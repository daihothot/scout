import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isPathWithin } from "../../core/path.js";

/** Resolves an `assets/...` command argument against the repository asset root. */
export function resolveAssetArg(argument: string, assetsRoot: string): string {
  return argument.startsWith("assets/") ? resolveAssetLocalPath(argument, assetsRoot) : argument;
}

/** Resolves an asset-local command path and rejects traversal outside `assetsRoot`. */
export function resolveAssetLocalPath(assetPath: string, assetsRoot: string): string {
  const repoRoot = resolve(assetsRoot, "..", "..");
  const resolvedPath = resolve(repoRoot, assetPath);
  const relativePath = relative(resolve(assetsRoot), resolvedPath);
  if (
    relativePath.length > 0
    && (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(".." + sep))
  ) {
    throw new Error(`Asset-local path escapes assets root: ${assetPath}`);
  }
  return resolvedPath;
}

/** Resolves an asset-relative path while enforcing containment by `assetsRoot`. */
export function resolveAssetRelativePath(assetPath: string, assetsRoot: string): string {
  const resolvedPath = resolve(assetsRoot, assetPath);
  if (!isPathWithin(assetsRoot, resolvedPath)) {
    throw new Error(`Asset path escapes assets root: ${assetPath}`);
  }
  return resolvedPath;
}

/** Resolves an asset-local reference and fails if the referenced file is missing. */
export function resolveRequiredAssetFile(assetPath: string, assetsRoot: string): string {
  const resolvedPath = resolveAssetArg(assetPath, assetsRoot);
  if (!existsSync(resolvedPath)) throw new Error(`Asset-local resource is missing: ${assetPath}`);
  return resolvedPath;
}

/** Fails when a profile-selected asset path is absent or escapes the asset root. */
export function assertAssetFileExists(assetsRoot: string, assetPath: string, label: string): void {
  if (!existsSync(resolveAssetRelativePath(assetPath, assetsRoot))) {
    throw new Error(`Agent profile references missing ${label}: ${assetPath}`);
  }
}

/** Rejects names that could introduce traversal or multi-segment mount paths. */
export function assertMountPathSegment(value: string, label: string): void {
  if (value === "." || value === ".." || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

/** Converts an asset-relative path into the portable source path recorded in manifests. */
export function assetSourcePath(assetPath: string): string {
  return join("assets", "codex", assetPath);
}

/** Extracts the Codex custom-agent name represented by a TOML asset path. */
export function customAgentNameFromPath(customAgentPath: string): string {
  return basename(customAgentPath, ".toml");
}

/** Extracts a Scout Skill name from either its directory or `SKILL.md` path. */
export function skillNameFromPath(skillPath: string): string {
  const source = resolve(skillPath);
  return basename(source) === "SKILL.md" ? basename(resolve(source, "..")) : basename(source);
}

/** Returns a relative path, using `.` when both inputs identify the same location. */
export function relativeOrSelf(base: string, target: string): string {
  const relativePath = relative(base, target);
  return relativePath.length === 0 ? "." : relativePath;
}
