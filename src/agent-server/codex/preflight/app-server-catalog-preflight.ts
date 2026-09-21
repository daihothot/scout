import { resolve } from "node:path";
import type { CodexMount } from "../../../asset-store/contracts/mount.js";
import type { CodexAppServerClient } from "../app-server-client.js";

export interface CodexMountCatalog {
  skillsList: unknown;
  hooksList: unknown;
}

/** Discovers Codex-native Skill and hook catalogs for every prepared mount. */
export async function discoverCodexMountCatalogs(
  appServer: CodexAppServerClient,
  mounts: readonly CodexMount[],
): Promise<ReadonlyMap<string, CodexMountCatalog>> {
  const cwds = mounts.map((mount) => resolve(mount.mountRoot));
  const expected = new Set(cwds);
  if (expected.size !== cwds.length) {
    throw new Error("Catalog discovery received duplicate mount roots.");
  }

  const skillsResponse = await appServer.request("skills/list", {
    cwds,
    forceReload: true,
  });
  const skillsByCwd = splitCatalogResponse(skillsResponse, expected, "skills/list");

  let hooksResponse: unknown;
  try {
    hooksResponse = await appServer.request("hooks/list", { cwds });
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    return new Map(cwds.map((cwd) => [
      cwd,
      {
        skillsList: skillsByCwd.get(cwd),
        hooksList: { warning },
      },
    ]));
  }
  const hooksByCwd = splitCatalogResponse(hooksResponse, expected, "hooks/list");

  return new Map(cwds.map((cwd) => [
    cwd,
    {
      skillsList: skillsByCwd.get(cwd),
      hooksList: hooksByCwd.get(cwd),
    },
  ]));
}

function splitCatalogResponse(
  response: unknown,
  expectedCwds: ReadonlySet<string>,
  method: "skills/list" | "hooks/list",
): ReadonlyMap<string, unknown> {
  const root = readObjectOrUndefined(response);
  if (!root) throw new Error(`${method} returned a non-object response.`);
  const data = readArrayOrUndefined(root.data);
  if (!data) throw new Error(`${method} did not return data entries.`);

  const byCwd = new Map<string, unknown>();
  for (const entry of data) {
    const object = readObjectOrUndefined(entry);
    if (!object || typeof object.cwd !== "string") {
      throw new Error(`${method} returned an entry without cwd.`);
    }
    const cwd = resolve(object.cwd);
    if (!expectedCwds.has(cwd)) {
      throw new Error(`${method} returned an unknown cwd: ${cwd}.`);
    }
    if (byCwd.has(cwd)) {
      throw new Error(`${method} returned a duplicate cwd: ${cwd}.`);
    }
    byCwd.set(cwd, { ...root, data: [entry] });
  }
  for (const cwd of expectedCwds) {
    if (!byCwd.has(cwd)) {
      throw new Error(`${method} did not return cwd: ${cwd}.`);
    }
  }
  return byCwd;
}

function readObjectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readArrayOrUndefined(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
