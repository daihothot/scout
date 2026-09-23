import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveAssetRelativePath } from "./asset-paths.js";

/** Reads JSON values beneath one fixed Asset directory without interpreting their schema. */
export class AssetJsonReader {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Returns the parsed JSON structure for one path contained by this reader's Asset root. */
  readJson(path: string): unknown {
    const resolvedPath = resolveAssetRelativePath(path, this.root);
    let source: string;
    try {
      source = readFileSync(resolvedPath, "utf8");
    } catch (error) {
      throw new Error(`Cannot read Asset JSON ${resolvedPath}.`, { cause: error });
    }
    try {
      return JSON.parse(source) as unknown;
    } catch (error) {
      throw new Error(`Invalid Asset JSON at ${resolvedPath}.`, { cause: error });
    }
  }
}
