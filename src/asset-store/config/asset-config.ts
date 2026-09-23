import { extname, resolve } from "node:path";
import { AssetJsonReader } from "../files/asset-json-reader.js";

/** Reads free-form Scout configuration through the reader selected by file suffix. */
export class AssetConfig {
  readonly root: string;
  private readonly jsonReader: AssetJsonReader;

  constructor(root: string) {
    this.root = resolve(root);
    this.jsonReader = new AssetJsonReader(this.root);
  }

  /** Returns a parsed configuration structure without interpreting user-owned fields. */
  read(fileName: string): unknown {
    const suffix = extname(fileName).toLowerCase();
    if (suffix !== ".json") {
      throw new Error(
        `Unsupported Asset config file suffix for ${fileName}: ${suffix || "<none>"}.`,
      );
    }
    try {
      return this.jsonReader.readJson(fileName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot load Asset config ${fileName}: ${message}`,
        { cause: error },
      );
    }
  }
}
