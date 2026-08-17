import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  buildScoutSkillCatalog,
  listScoutSkillPaths,
  parseScoutSkillMetadata,
  parseScoutSkillResourceMetadata,
  resolveScoutSkillsForPhase,
  resolveSkillDependencyLoadOrder,
  validateScoutSkillCatalog,
  type AgentProfilesFile,
  type ScoutSkillCatalogEntry,
} from "../../src/asset-store/index.js";

const scoutRoot = process.cwd();
const assetsRoot = join(scoutRoot, "assets", "codex");

test("every Scout Skill has a phase, filesystem family, and canonical mount path", () => {
  const catalog = buildScoutSkillCatalog({
    assetsRoot,
    skillPaths: listScoutSkillPaths(assetsRoot),
  });
  assert.ok(catalog.length >= 20);
  assert.equal(new Set(catalog.map((skill) => skill.name)).size, catalog.length);
  for (const skill of catalog) {
    assert.ok(Array.isArray(skill.phase));
    assert.ok(skill.family.length > 0);
    assert.ok(skill.tags.length > 0);
    assert.ok(skill.description.length > 0);
    assert.ok(skill.summary.length > 0);
    assert.equal(
      skill.path,
      posix.join(".scout", "skill", ...skill.family, skill.name, "SKILL.md"),
    );
  }

  const byName = new Map(catalog.map((skill) => [skill.name, skill] as const));
  assert.deepEqual(byName.get("domain-validation-researcher")?.family, [
    "validation", "workflow",
  ]);
  assert.deepEqual(byName.get("signal-unity-runtime-log")?.family, [
    "validation", "single", "unity", "local", "general",
  ]);
  assert.deepEqual(byName.get("tool-scout-submit-task")?.family, [
    "tool", "scout", "dynamic",
  ]);
});

test("each profile phase projects every visible Skill and its dependency closure", () => {
  const profiles = JSON.parse(readFileSync(
    join(assetsRoot, "agents", "agent-profiles.json"),
    "utf8",
  )) as AgentProfilesFile;
  const catalog = buildScoutSkillCatalog({
    assetsRoot,
    skillPaths: listScoutSkillPaths(assetsRoot),
  });
  const expectedInventories: Record<string, string[]> = {
    coordinator: [
      "domain-validation-coordinator",
      "internal-boundary-inspector",
      "tool-scout-archive-task",
      "tool-scout-assign-task",
      "tool-scout-respond-human-input",
      "tool-scout-send-message",
    ],
    researcher: [
      "domain-validation-research-pack",
      "domain-validation-researcher",
      "internal-boundary-inspector",
      "internal-single-skill-reader",
      "signal-unity-callback-event-by-runtime-log",
      "signal-unity-local-storage",
      "signal-unity-runtime-log",
      "tool-guru-knowledge",
      "tool-jarvis-codebase",
      "tool-scout-request-human-input",
      "tool-scout-send-message",
      "tool-scout-submit-task",
    ],
    verifier: [
      "domain-validation-verifier",
      "internal-boundary-inspector",
      "internal-single-skill-reader",
      "signal-unity-callback-event-by-runtime-log",
      "signal-unity-local-storage",
      "signal-unity-runtime-log",
      "signal-unity-runtime-log-unity-pipeline-cli",
      "tool-jarvis-codebase",
      "tool-scout-request-human-input",
      "tool-scout-send-message",
      "tool-scout-submit-task",
      "tool-unity-pipeline-cli",
    ],
    validator: [
      "domain-validation-research-pack",
      "domain-validation-validator",
      "domain-validation-verifier",
      "internal-boundary-inspector",
      "internal-single-skill-reader",
      "signal-unity-callback-event-by-runtime-log",
      "signal-unity-local-storage",
      "signal-unity-runtime-log",
      "signal-unity-runtime-log-unity-pipeline-cli",
      "tool-guru-knowledge",
      "tool-jarvis-codebase",
      "tool-scout-request-human-input",
      "tool-scout-send-message",
      "tool-scout-submit-task",
      "tool-unity-pipeline-cli",
    ],
  };

  for (const [role, profile] of Object.entries(profiles.profiles)) {
    const projected = resolveScoutSkillsForPhase(catalog, profile.phase);
    assert.deepEqual(
      projected.map((skill) => skill.name).sort(),
      expectedInventories[role]?.sort(),
    );
    assert.ok(projected.every((skill) => skill.phase.includes(profile.phase)));
    assert.equal(projected.some((skill) => skill.name === "internal-skill-creator"), false);
  }
});

test("Scout Skill resources retain resource-level required and optional metadata", () => {
  assert.deepEqual(parseScoutSkillResourceMetadata({
    path: "templates/report.md",
    text: [
      "---",
      "scout:",
      "  resource:",
      "    requirement: required",
      "    description: Canonical report structure.",
      "artifact_type: Report",
      "---",
    ].join("\n"),
  }), {
    path: "templates/report.md",
    requirement: "required",
    description: "Canonical report structure.",
  });
  assert.equal(parseScoutSkillResourceMetadata({
    path: "references/remediation.md",
    text: [
      "---",
      "scout:",
      "  resource:",
      "    requirement: optional",
      "    description: Conditional remediation reference.",
      "---",
    ].join("\n"),
  }).requirement, "optional");
});

test("Scout Skill resource metadata rejects missing, invalid, duplicate, and unsafe fields", () => {
  const resource = (metadata: string[], path = "templates/report.md"): unknown =>
    parseScoutSkillResourceMetadata({
      path,
      text: `---\n${metadata.join("\n")}\n---\n`,
    });
  assert.throws(
    () => resource(["scout:", "  resource:", "    description: Report."]),
    /must define scout\.resource\.requirement/,
  );
  assert.throws(
    () => resource([
      "scout:", "  resource:", "    requirement: conditional", "    description: Report.",
    ]),
    /unsupported scout\.resource\.requirement: conditional/,
  );
  assert.throws(
    () => resource(["scout:", "  resource:", "    requirement: required"]),
    /must define scout\.resource\.description/,
  );
  assert.throws(
    () => resource([
      "scout:", "  resource:", "    requirement: required",
      "    requirement: optional", "    description: Report.",
    ]),
    /duplicate field: scout\.resource\.requirement/,
  );
  for (const path of [
    "report.md",
    "templates/../report.md",
    "templates\\report.md",
    "/templates/report.md",
    "templates/report.txt",
  ]) {
    assert.throws(
      () => resource([
        "scout:", "  resource:", "    requirement: required", "    description: Report.",
      ], path),
      /resource path/,
      path,
    );
  }
});

test("Scout Skill catalog recursively discovers resources and rejects resource symlinks", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-skill-resources-"));
  const skillRoot = join(fixtureRoot, "skills", "example");
  try {
    mkdirSync(join(skillRoot, "templates", "nested"), { recursive: true });
    writeFileSync(join(skillRoot, "SKILL.md"), scoutSkillText("example"));
    writeFileSync(join(skillRoot, "templates", "nested", "report.md"), [
      "---",
      "scout:",
      "  resource:",
      "    requirement: required",
      "    description: Report template.",
      "---",
    ].join("\n"));
    const catalog = buildScoutSkillCatalog({
      assetsRoot: fixtureRoot,
      skillPaths: [join("skills", "example", "SKILL.md")],
    });
    assert.deepEqual(catalog[0]?.resources, [{
      path: "templates/nested/report.md",
      requirement: "required",
      description: "Report template.",
    }]);

    writeFileSync(join(skillRoot, "target.md"), "target\n");
    symlinkSync(join(skillRoot, "target.md"), join(skillRoot, "templates", "linked.md"));
    assert.throws(
      () => buildScoutSkillCatalog({
        assetsRoot: fixtureRoot,
        skillPaths: [join("skills", "example", "SKILL.md")],
      }),
      /resource path must not be a symbolic link/,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("Scout Skill metadata requires current phase, family, tags, and token formats", () => {
  assert.throws(() => parseMetadata("missing-phase", { phase: null }), /must define phase/);
  assert.deepEqual(parseMetadata("off-runtime", { phase: "[]" }).phase, []);
  assert.throws(() => parseMetadata("missing-family", { family: null }), /must define non-empty family/);
  assert.throws(() => parseMetadata("missing-tags", { tags: null }), /must define non-empty tags/);
  assert.throws(() => parseMetadata("unsupported-phase", { phase: "[deploy]" }), /unsupported phase: deploy/);
  assert.throws(() => parseMetadata("invalid-family", { family: "[Validation]" }), /family has invalid token/);
  assert.throws(() => parseMetadata("duplicate-tag", { tags: "[research, research]" }), /tags contains duplicate token/);
  assert.throws(() => parseMetadata("duplicate-family", { family: "[domain, domain]" }), /family contains duplicate token/);
  assert.throws(
    () => parseMetadata("invalid-dependency", { requiredSkills: "[other_skill]" }),
    /dependencies\.skills\.required has invalid token/,
  );
});

test("Scout Skill dependency order is dependency-first, de-duplicated, and phase-safe", () => {
  const catalog = [
    parseMetadata("foundation"),
    parseMetadata("producer", { requiredSkills: "[foundation]" }),
    parseMetadata("workflow", { requiredSkills: "[producer, foundation]" }),
    parseMetadata("audit", { requiredSkills: "[foundation]" }),
  ];
  assert.deepEqual(
    resolveSkillDependencyLoadOrder(catalog, ["workflow", "audit"]).map((skill) => skill.name),
    ["foundation", "producer", "workflow", "audit"],
  );
  assert.throws(
    () => resolveSkillDependencyLoadOrder([
      parseMetadata("workflow", { requiredSkills: "[missing-producer]" }),
    ], ["workflow"]),
    /Unknown Scout Skill dependency/,
  );
  assert.throws(
    () => resolveSkillDependencyLoadOrder([
      parseMetadata("alpha", { requiredSkills: "[beta]" }),
      parseMetadata("beta", { requiredSkills: "[alpha]" }),
    ], ["alpha"]),
    /dependency cycle/,
  );
  assert.throws(
    () => validateScoutSkillCatalog([
      parseMetadata("producer", { phase: "[research]" }),
      parseMetadata("workflow", { phase: "[research, validate]", requiredSkills: "[producer]" }),
    ]),
    /dependency producer does not support phase validate/,
  );
});

test("filesystem families may contain siblings and prefix directories", () => {
  assert.doesNotThrow(() => validateScoutSkillCatalog([
    parseMetadata("entry-one", { family: "[validation, workflow]" }),
    parseMetadata("entry-two", { family: "[validation, workflow]" }),
    parseMetadata("entry-three", { family: "[validation, workflow, specialized]" }),
  ]));
});

function parseMetadata(
  name: string,
  options: {
    phase?: string | null;
    family?: string | null;
    tags?: string | null;
    requiredSkills?: string;
  } = {},
): ScoutSkillCatalogEntry {
  const lines = [
    "assetKind: scout.skill",
    `name: ${name}`,
    "description: Test Scout Skill metadata.",
    `id: ${name}`,
    "version: 1.0.0",
    ...(options.phase === null ? [] : [`phase: ${options.phase ?? "[research]"}`]),
    ...(options.family === null ? [] : [`family: ${options.family ?? `[test, ${name}]`}`]),
    ...(options.tags === null ? [] : [`tags: ${options.tags ?? "[test]"}`]),
    ...(options.requiredSkills
      ? ["dependencies:", "  skills:", `    required: ${options.requiredSkills}`]
      : []),
    "summary: Test metadata.",
  ];
  return parseScoutSkillMetadata({
    text: `---\n${lines.join("\n")}\n---\n`,
    expectedName: name,
    resources: [],
  });
}

function scoutSkillText(name: string): string {
  return [
    "---",
    "assetKind: scout.skill",
    `name: ${name}`,
    "description: Test Scout Skill metadata.",
    `id: ${name}`,
    "version: 1.0.0",
    "phase: [research]",
    `family: [test, ${name}]`,
    "tags: [test]",
    "summary: Test metadata.",
    "---",
    "",
  ].join("\n");
}
