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

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function writeTextFile(path: string, content: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, content, "utf8");
}

export function recreateDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
  ensureDir(path);
}

export function recreateParentDir(path: string): void {
  recreateDir(dirname(path));
}

export function safeSymlink(target: string, linkPath: string): void {
  ensureDir(dirname(linkPath));
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(target, linkPath);
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sha256File(path: string): string {
  return sha256Text(readFileSync(path, "utf8"));
}

export function hashDirectory(path: string): string {
  const entries = listFiles(path)
    .map((filePath) => {
      const rel = relative(path, filePath);
      return `${rel}:${sha256File(filePath)}`;
    })
    .join("\n");
  return sha256Text(entries);
}

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

export function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJsonFile(path: string, value: unknown): void {
  writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
}
