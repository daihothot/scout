import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import {
  AgentSkillError,
  normalizeAgentSkillResourcePath,
  readAgentSkillResource,
} from "../../src/agent/skill/index.js";
import { ScoutAgentPhases } from "../../src/agent/thread/types.js";
import {
  ScoutSkillResourceRequirements,
  type ScoutSkillCatalogEntry,
  type ScoutSkillResourceCatalogEntry,
} from "../../src/asset-store/contracts/skill.js";

test("Skill resource reader reads mounted SKILL.md text", (t) => {
  const fixture = createReaderFixture(t);
  const content = "# Base contract\n\nFollow the contract.\n";
  writeFileSync(join(fixture.skillSourceRoot, "SKILL.md"), content, "utf8");

  assert.deepEqual(readAgentSkillResource({
    scoutRoot: fixture.scoutRoot,
    mountRoot: fixture.mountRoot,
    skill: fixture.skill,
    resource: "SKILL.md",
  }), {
    resource: "SKILL.md",
    content,
    digest: digest(content),
    byteLength: Buffer.byteLength(content, "utf8"),
  });
});

test("Skill resource reader projects supplementary control metadata before digesting", (t) => {
  const fixture = createReaderFixture(t);
  const metadata = resourceMetadata(
    "references/details.md",
    ScoutSkillResourceRequirements.Required,
    "Contract details.",
  );
  const source = [
    "---",
    "title: Contract details",
    "scout:",
    "  resource:",
    "    requirement: required",
    "    description: Contract details.",
    "artifact_type: ContractReference",
    "---",
    "# Details",
    "",
    "Returned body.",
    "",
  ].join("\n");
  const projected = [
    "---",
    "title: Contract details",
    "artifact_type: ContractReference",
    "---",
    "# Details",
    "",
    "Returned body.",
    "",
  ].join("\n");
  writeResource(fixture, metadata.path, source);

  const result = readAgentSkillResource({
    scoutRoot: fixture.scoutRoot,
    mountRoot: fixture.mountRoot,
    skill: fixture.skill,
    resource: metadata.path,
    supplementaryResource: metadata,
  });

  assert.equal(result.content, projected);
  assert.doesNotMatch(result.content, /scout:|requirement:|description:/);
  assert.equal(result.digest, digest(projected));
  assert.equal(result.byteLength, Buffer.byteLength(projected, "utf8"));
});

test("Skill resource reader rejects supplementary metadata that differs from the file", (t) => {
  const fixture = createReaderFixture(t);
  const resource = resourceMetadata(
    "references/details.md",
    ScoutSkillResourceRequirements.Required,
    "Catalog description.",
  );
  writeResource(fixture, resource.path, [
    "---",
    "scout:",
    "  resource:",
    "    requirement: optional",
    "    description: File description.",
    "---",
    "# Details",
  ].join("\n"));

  assertSkillError("resource_control_metadata_invalid", () => readAgentSkillResource({
    scoutRoot: fixture.scoutRoot,
    mountRoot: fixture.mountRoot,
    skill: fixture.skill,
    resource: resource.path,
    supplementaryResource: resource,
  }));
});

test("Skill resource reader rejects a mounted Skill root retargeted to another source Skill", (t) => {
  const fixture = createReaderFixture(t);
  const alternateRoot = join(
    fixture.scoutRoot,
    "assets",
    "codex",
    "skills",
    "alternate-contract",
  );
  mkdirSync(alternateRoot, { recursive: true });
  writeFileSync(join(alternateRoot, "SKILL.md"), "# Alternate contract\n", "utf8");
  unlinkSync(fixture.mountedSkillRoot);
  symlinkSync(alternateRoot, fixture.mountedSkillRoot, "dir");

  assertSkillError("resource_path_escape", () => readAgentSkillResource({
    scoutRoot: fixture.scoutRoot,
    mountRoot: fixture.mountRoot,
    skill: fixture.skill,
    resource: "SKILL.md",
  }));
});

test("Skill resource reader rejects a supplementary symlink escaping the Skill root", (t) => {
  const fixture = createReaderFixture(t);
  const resource = resourceMetadata(
    "references/linked.md",
    ScoutSkillResourceRequirements.Optional,
    "Linked reference.",
  );
  const outside = join(fixture.scoutRoot, "outside.md");
  writeFileSync(outside, "# Outside\n", "utf8");
  mkdirSync(join(fixture.skillSourceRoot, "references"), { recursive: true });
  symlinkSync(outside, join(fixture.skillSourceRoot, ...resource.path.split("/")));

  assertSkillError("resource_path_escape", () => readAgentSkillResource({
    scoutRoot: fixture.scoutRoot,
    mountRoot: fixture.mountRoot,
    skill: fixture.skill,
    resource: resource.path,
    supplementaryResource: resource,
  }));
});

test("Skill resource path normalization rejects traversal, absolute paths, and backslashes", () => {
  assert.equal(
    normalizeAgentSkillResourcePath("references/nested/details.md"),
    "references/nested/details.md",
  );
  for (const resource of [
    "../outside.md",
    "references/../outside.md",
    "/absolute.md",
    "C:\\absolute.md",
    "references\\details.md",
  ]) {
    assertSkillError(
      "invalid_resource_path",
      () => normalizeAgentSkillResourcePath(resource),
    );
  }
  assertSkillError(
    "resource_path_too_long",
    () => normalizeAgentSkillResourcePath(`references/${"a".repeat(502)}.md`),
  );
});

test("Skill resource reader rejects a declared Markdown path that is not a file", (t) => {
  const fixture = createReaderFixture(t);
  const resource = resourceMetadata(
    "references/directory.md",
    ScoutSkillResourceRequirements.Optional,
    "Directory path.",
  );
  mkdirSync(join(fixture.skillSourceRoot, "references", "directory.md"), {
    recursive: true,
  });

  assertSkillError("resource_not_file", () => readAgentSkillResource({
    scoutRoot: fixture.scoutRoot,
    mountRoot: fixture.mountRoot,
    skill: fixture.skill,
    resource: resource.path,
    supplementaryResource: resource,
  }));
});

test("Skill resource reader rejects an oversized declared Markdown resource", (t) => {
  const fixture = createReaderFixture(t);
  const resource = resourceMetadata(
    "references/oversized.md",
    ScoutSkillResourceRequirements.Optional,
    "Oversized reference.",
  );
  writeResource(fixture, resource.path, Buffer.alloc(256 * 1024 + 1, "a"));

  assertSkillError("resource_too_large", () => readAgentSkillResource({
    scoutRoot: fixture.scoutRoot,
    mountRoot: fixture.mountRoot,
    skill: fixture.skill,
    resource: resource.path,
    supplementaryResource: resource,
  }));
});

test("Skill resource reader rejects NUL and invalid UTF-8 in declared Markdown resources", (t) => {
  const fixture = createReaderFixture(t);
  const nulResource = resourceMetadata(
    "references/nul.md",
    ScoutSkillResourceRequirements.Optional,
    "NUL reference.",
  );
  const invalidUtf8Resource = resourceMetadata(
    "references/invalid-utf8.md",
    ScoutSkillResourceRequirements.Optional,
    "Invalid UTF-8 reference.",
  );
  writeResource(fixture, nulResource.path, Buffer.from("text\0body", "utf8"));
  writeResource(fixture, invalidUtf8Resource.path, Buffer.from([0xc3, 0x28]));

  for (const resource of [nulResource, invalidUtf8Resource]) {
    assertSkillError("resource_not_text", () => readAgentSkillResource({
      scoutRoot: fixture.scoutRoot,
      mountRoot: fixture.mountRoot,
      skill: fixture.skill,
      resource: resource.path,
      supplementaryResource: resource,
    }));
  }
});

interface ReaderFixture {
  scoutRoot: string;
  mountRoot: string;
  skillSourceRoot: string;
  mountedSkillRoot: string;
  skill: ScoutSkillCatalogEntry;
}

function createReaderFixture(t: TestContext): ReaderFixture {
  const scoutRoot = mkdtempSync(join(tmpdir(), "scout-skill-resource-reader-"));
  t.after(() => rmSync(scoutRoot, { recursive: true, force: true }));
  const mountRoot = join(scoutRoot, "run", "agent-mount");
  const skillSourceRoot = join(
    scoutRoot,
    "assets",
    "codex",
    "skills",
    "base-contract",
  );
  const mountedSkillRoot = join(
    mountRoot,
    ".scout",
    "skills",
    "base-contract",
  );
  mkdirSync(skillSourceRoot, { recursive: true });
  mkdirSync(dirname(mountedSkillRoot), { recursive: true });
  writeFileSync(join(skillSourceRoot, "SKILL.md"), "# Base contract\n", "utf8");
  symlinkSync(skillSourceRoot, mountedSkillRoot, "dir");

  return {
    scoutRoot,
    mountRoot,
    skillSourceRoot,
    mountedSkillRoot,
    skill: {
      name: "base-contract",
      description: "Base contract description.",
      summary: "Base contract summary.",
      phase: [ScoutAgentPhases.Research],
      family: ["catalog", "contract"],
      tags: ["contract"],
      requiredSkills: [],
      path: ".scout/skills/base-contract/SKILL.md",
      resources: [],
    },
  };
}

function resourceMetadata(
  path: string,
  requirement: ScoutSkillResourceCatalogEntry["requirement"],
  description: string,
): ScoutSkillResourceCatalogEntry {
  return { path, requirement, description };
}

function writeResource(
  fixture: ReaderFixture,
  resource: string,
  content: string | Buffer,
): void {
  const path = join(fixture.skillSourceRoot, ...resource.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex")}`;
}

function assertSkillError(code: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof AgentSkillError);
    assert.equal(error.code, code);
    return true;
  });
}
