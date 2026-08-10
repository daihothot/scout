import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** Ensures a directory exists, creating missing ancestors synchronously. */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Creates parent directories and writes UTF-8 text to the requested path. */
export function writeTextFile(path: string, content: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, content, "utf8");
}

/** Removes an existing directory tree and recreates its root. */
export function recreateDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
  ensureDir(path);
}

/** Recreates the directory containing a target path, including its parent tree. */
export function recreateParentDir(path: string): void {
  recreateDir(dirname(path));
}

/** Replaces a link path with a symlink after ensuring its parent exists. */
export function safeSymlink(target: string, linkPath: string): void {
  ensureDir(dirname(linkPath));
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(target, linkPath);
}

/** Returns the SHA-256 digest of UTF-8 text. */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Returns the SHA-256 digest of a UTF-8 file. */
export function sha256File(path: string): string {
  return sha256Text(readFileSync(path, "utf8"));
}

/** Serializes JSON-shaped data with object keys in lexical order. Array order is preserved. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonObjectKeys(value));
}

function sortJsonObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, sortJsonObjectKeys(child)]),
  );
}

/** Hashes a directory from sorted relative file names and their file digests. */
export function hashDirectory(path: string): string {
  const entries = listFiles(path)
    .map((filePath) => {
      const rel = relative(path, filePath);
      return `${rel}:${sha256File(filePath)}`;
    })
    .join("\n");
  return sha256Text(entries);
}

/** Recursively lists regular files as normalized absolute paths in lexical order. */
export function listFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (stat.isFile()) return [resolve(path)];
  if (!stat.isDirectory()) return [];

  const results: string[] = [];
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    const childStat = lstatSync(child);
    if (childStat.isDirectory()) {
      results.push(...listFiles(child));
    } else if (childStat.isFile()) {
      results.push(resolve(child));
    }
  }
  return results.sort();
}

/** Parses a UTF-8 JSON file into the requested caller-supplied type. */
export function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Serializes a value as indented JSON after creating its parent directory. */
export function writeJsonFile(path: string, value: unknown): void {
  writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
}
