import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, win32 } from "node:path";
import { projectScoutSkillResourceText } from "../../asset-store/assets/skill-catalog.js";
import type {
  ScoutSkillCatalogEntry,
  ScoutSkillResourceCatalogEntry,
} from "../../asset-store/contracts/skill.js";
import { isPathWithin } from "../../core/path.js";
import { AgentSkillError } from "./types.js";

const MAX_SKILL_RESOURCE_BYTES = 256 * 1024;
const MAX_SKILL_RESOURCE_PATH_LENGTH = 512;

/** Runtime paths already authorized by the current Agent mount and selection. */
export interface ReadAgentSkillResourceInput {
  scoutRoot: string;
  mountRoot: string;
  skill: ScoutSkillCatalogEntry;
  resource: string;
  supplementaryResource?: ScoutSkillResourceCatalogEntry;
}

/** Text returned to the Agent after control metadata has been projected out. */
export interface AgentSkillResourceText {
  resource: string;
  content: string;
  digest: string;
  byteLength: number;
}

/**
 * Reads one authorized Skill resource while enforcing both mount-path and
 * canonical source-asset containment.
 */
export function readAgentSkillResource(
  input: ReadAgentSkillResourceInput,
): AgentSkillResourceText {
  const resource = normalizeAgentSkillResourcePath(input.resource);
  if (resource === "SKILL.md") {
    if (input.supplementaryResource !== undefined) {
      throw new AgentSkillError(
        "resource_control_metadata_invalid",
        "SKILL.md cannot use supplementary resource metadata.",
      );
    }
  } else if (
    input.supplementaryResource === undefined
    || input.supplementaryResource.path !== resource
  ) {
    throw new AgentSkillError(
      "resource_control_metadata_invalid",
      `Skill ${input.skill.name} resource ${resource} is missing its authorized metadata.`,
    );
  }

  const mountedSkillsRoot = resolve(input.mountRoot, ".scout", "skills");
  const declaredSkillFile = resolve(input.mountRoot, ...input.skill.path.split("/"));
  const declaredSkillRoot = dirname(declaredSkillFile);
  assertPathInside(mountedSkillsRoot, declaredSkillRoot, "Skill catalog path");

  const expectedSkillRoot = resolve(
    input.scoutRoot,
    "assets",
    "codex",
    "skills",
    input.skill.name,
  );
  let realExpectedSkillRoot: string;
  let realSkillRoot: string;
  let realResourcePath: string;
  try {
    realExpectedSkillRoot = realpathSync(expectedSkillRoot);
    realSkillRoot = realpathSync(declaredSkillRoot);
    realResourcePath = realpathSync(resolve(declaredSkillRoot, ...resource.split("/")));
  } catch {
    throw new AgentSkillError(
      "resource_not_found",
      `Skill ${input.skill.name} resource ${resource} does not exist.`,
    );
  }
  if (realSkillRoot !== realExpectedSkillRoot) {
    throw new AgentSkillError(
      "resource_path_escape",
      "Resolved Skill root does not match its authorized source asset.",
    );
  }
  assertPathInside(realSkillRoot, realResourcePath, "Resolved Skill resource");

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(realResourcePath);
  } catch {
    throw new AgentSkillError(
      "resource_not_found",
      `Skill ${input.skill.name} resource ${resource} does not exist.`,
    );
  }
  if (!stat.isFile()) {
    throw new AgentSkillError(
      "resource_not_file",
      `Skill ${input.skill.name} resource ${resource} is not a regular file.`,
    );
  }
  if (stat.size > MAX_SKILL_RESOURCE_BYTES) {
    throw new AgentSkillError(
      "resource_too_large",
      `Skill resource exceeds the ${MAX_SKILL_RESOURCE_BYTES} byte limit.`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(realResourcePath);
  } catch {
    throw new AgentSkillError(
      "resource_read_failed",
      `Skill ${input.skill.name} resource ${resource} could not be read.`,
    );
  }
  if (bytes.byteLength > MAX_SKILL_RESOURCE_BYTES) {
    throw new AgentSkillError(
      "resource_too_large",
      `Skill resource exceeds the ${MAX_SKILL_RESOURCE_BYTES} byte limit.`,
    );
  }
  if (bytes.includes(0)) {
    throw new AgentSkillError("resource_not_text", "Skill resource contains NUL bytes.");
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AgentSkillError("resource_not_text", "Skill resource is not valid UTF-8 text.");
  }
  if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) {
    throw new AgentSkillError(
      "resource_not_text",
      "Skill resource contains unsupported control characters.",
    );
  }

  if (input.supplementaryResource !== undefined) {
    try {
      content = projectScoutSkillResourceText({
        text: content,
        path: resource,
        expected: input.supplementaryResource,
        sourcePath: realResourcePath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AgentSkillError(
        "resource_control_metadata_invalid",
        `Skill ${input.skill.name} resource ${resource} control metadata is invalid: ${message}`,
      );
    }
  }

  const returnedBytes = Buffer.from(content, "utf8");
  return {
    resource,
    content,
    digest: `sha256:${createHash("sha256").update(returnedBytes).digest("hex")}`,
    byteLength: returnedBytes.byteLength,
  };
}

/** Rejects path syntax before any filesystem resolution is attempted. */
export function normalizeAgentSkillResourcePath(resource: string): string {
  if (resource.length > MAX_SKILL_RESOURCE_PATH_LENGTH) {
    throw new AgentSkillError(
      "resource_path_too_long",
      `Skill resource path exceeds ${MAX_SKILL_RESOURCE_PATH_LENGTH} characters.`,
    );
  }
  if (
    resource.includes("\0")
    || resource.includes("\\")
    || isAbsolute(resource)
    || win32.isAbsolute(resource)
  ) {
    throw new AgentSkillError(
      "invalid_resource_path",
      "Skill resource must be a POSIX relative path without NUL or backslash characters.",
    );
  }
  const segments = resource.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new AgentSkillError(
      "invalid_resource_path",
      "Skill resource path cannot contain empty, dot, or parent segments.",
    );
  }
  return segments.join("/");
}

function assertPathInside(root: string, target: string, label: string): void {
  if (!isPathWithin(root, target)) {
    throw new AgentSkillError(
      "resource_path_escape",
      `${label} escapes its authorized Skill root.`,
    );
  }
}
