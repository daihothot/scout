import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildScoutSkillCatalog,
  parseScoutSkillMetadata,
  parseScoutSkillResourceMetadata,
  projectScoutSkillResourceText,
  resolveSkillDependencyLoadOrder,
  validateScoutSkillCatalog,
  type AgentProfilesFile,
  type ScoutSkillCatalogEntry,
} from "../../src/asset-store/index.js";
import {
  ScoutAgentPhases,
} from "../../src/agent/thread/types.js";

const scoutRoot = process.cwd();
const assetsRoot = join(scoutRoot, "assets", "codex");

const expectedMetadata: Record<
  string,
  Pick<ScoutSkillCatalogEntry, "phase" | "family" | "tags">
> = {
  "domain-validation-coordinator": {
    phase: ["coordinate"],
    family: ["validation", "workflow", "coordinator"],
    tags: ["scout", "validation", "bdd", "coordination", "workflow"],
  },
  "domain-validation-research-pack": {
    phase: ["research", "validate"],
    family: undefined,
    tags: ["scout", "validation", "research", "pack", "evidence", "manual"],
  },
  "domain-validation-researcher": {
    phase: ["research"],
    family: ["validation", "workflow", "researcher"],
    tags: ["scout", "validation", "bdd", "research", "workflow"],
  },
  "domain-validation-validator": {
    phase: ["validate"],
    family: ["validation", "workflow", "validator"],
    tags: [
      "scout",
      "validation",
      "research",
      "verification",
      "gate",
      "evidence",
      "audit",
      "workflow",
    ],
  },
  "domain-validation-verifier": {
    phase: ["verify", "validate"],
    family: ["validation", "workflow", "verifier"],
    tags: ["scout", "validation", "bdd", "verification", "evidence", "workflow"],
  },
  "internal-boundary-inspector": {
    phase: ["coordinate", "research", "verify", "validate"],
    family: ["internal", "boundary-inspector"],
    tags: ["scout", "asset", "boundary", "memory", "audit", "workflow"],
  },
  "internal-skill-creator": {
    phase: [],
    family: ["internal", "skill-creator"],
    tags: ["scout", "skill", "asset", "template", "governance"],
  },
  "signal-unity-callback-event-by-runtime-log": {
    phase: ["research", "verify", "validate"],
    family: ["validation", "unity", "single", "local", "general", "callback-event"],
    tags: ["signal", "unity", "callback", "event", "runtime", "log"],
  },
  "signal-unity-local-storage": {
    phase: ["research", "verify", "validate"],
    family: ["validation", "unity", "single", "local", "general", "local-storage"],
    tags: ["signal", "unity", "local-storage", "sqlite"],
  },
  "signal-unity-runtime-log": {
    phase: ["research", "verify", "validate"],
    family: ["validation", "unity", "single", "local", "general", "runtime-log"],
    tags: ["signal", "unity", "runtime", "log"],
  },
  "signal-unity-runtime-log-unity-pipeline-cli": {
    phase: ["verify", "validate"],
    family: ["validation", "unity", "single", "local", "general", "runtime-log"],
    tags: [
      "signal",
      "unity",
      "verification",
      "runtime",
      "log",
      "pipeline",
      "cli",
      "shell-tool",
      "source",
    ],
  },
  "tool-guru-knowledge": {
    phase: ["research", "validate"],
    family: undefined,
    tags: ["guru", "knowledge", "bdd", "capability", "evidence", "source"],
  },
  "tool-jarvis-codebase": {
    phase: ["research", "verify", "validate"],
    family: undefined,
    tags: ["jarvis", "codebase", "codegraph", "source", "evidence"],
  },
  "tool-unity-pipeline-cli": {
    phase: ["verify", "validate"],
    family: undefined,
    tags: ["unity", "pipeline", "cli", "editor", "desktop", "player", "automation", "shell-tool"],
  },
};

test("Every Scout Skill has canonical phase, optional family, and feature tags", () => {
  const skillPaths = readdirSync(join(assetsRoot, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join("skills", entry.name, "SKILL.md"))
    .sort();
  const catalog = buildScoutSkillCatalog({ assetsRoot, skillPaths });

  assert.deepEqual(
    catalog.map((skill) => skill.name).sort(),
    Object.keys(expectedMetadata).sort(),
  );
  for (const skill of catalog) {
    assert.deepEqual(
      {
        phase: skill.phase,
        family: skill.family,
        tags: skill.tags,
      },
      expectedMetadata[skill.name],
      `${skill.name} selection metadata must stay canonical`,
    );
    assert.ok(skill.description.length > 0);
    assert.ok(skill.summary.length > 0);
    assert.equal(skill.path, `.scout/skills/${skill.name}/SKILL.md`);
    assert.ok(Array.isArray(skill.resources));
    assert.ok(skill.resources.every((resource) =>
      (resource.path.startsWith("templates/") || resource.path.startsWith("references/"))
      && resource.path.endsWith(".md")
      && (resource.requirement === "required" || resource.requirement === "optional")
      && resource.description.length > 0
    ));
  }
});

test("Scout Skill resources declare requirement and description in their own frontmatter", () => {
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
      "",
      "# Report",
    ].join("\n"),
  }), {
    path: "templates/report.md",
    requirement: "required",
    description: "Canonical report structure.",
  });
  assert.deepEqual(parseScoutSkillResourceMetadata({
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

test("Scout Skill resource projection removes only matching control metadata", () => {
  const path = "templates/report.md";
  const expected = {
    path,
    requirement: "required" as const,
    description: "Canonical report structure.",
  };
  const text = [
    "---",
    "scout:",
    "  resource:",
    "    requirement: required",
    "    description: Canonical report structure.",
    "  visibility: internal",
    "artifact_type: Report",
    "---",
    "",
    "# Report",
  ].join("\n");

  assert.equal(projectScoutSkillResourceText({ text, path, expected }), [
    "---",
    "scout:",
    "  visibility: internal",
    "artifact_type: Report",
    "---",
    "",
    "# Report",
  ].join("\n"));
});

test("Scout Skill resource projection removes an empty scout tree and preserves CRLF", () => {
  const path = "references/detail.md";
  const expected = {
    path,
    requirement: "optional" as const,
    description: "Conditional detail.",
  };
  const text = [
    "---",
    "scout:",
    "  resource:",
    "    requirement: optional",
    "    description: Conditional detail.",
    "artifact_type: Detail",
    "---",
    "",
    "Detail body.",
  ].join("\r\n");

  assert.equal(projectScoutSkillResourceText({ text, path, expected }), [
    "---",
    "artifact_type: Detail",
    "---",
    "",
    "Detail body.",
  ].join("\r\n"));
});

test("Scout Skill resource projection rejects catalog metadata mismatches", () => {
  const path = "templates/report.md";
  const text = [
    "---",
    "scout:",
    "  resource:",
    "    requirement: required",
    "    description: Canonical report structure.",
    "---",
  ].join("\n");
  const expected = {
    path,
    requirement: "required" as const,
    description: "Canonical report structure.",
  };

  assert.throws(
    () => projectScoutSkillResourceText({
      text,
      path: "references/report.md",
      expected,
    }),
    /path does not match its catalog entry/,
  );
  assert.throws(
    () => projectScoutSkillResourceText({
      text,
      path,
      expected: { ...expected, requirement: "optional" },
    }),
    /requirement does not match its catalog entry/,
  );
  assert.throws(
    () => projectScoutSkillResourceText({
      text,
      path,
      expected: { ...expected, description: "Different description." },
    }),
    /description does not match its catalog entry/,
  );
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
      "scout:",
      "  resource:",
      "    requirement: conditional",
      "    description: Report.",
    ]),
    /unsupported scout\.resource\.requirement: conditional/,
  );
  assert.throws(
    () => resource(["scout:", "  resource:", "    requirement: required"]),
    /must define scout\.resource\.description/,
  );
  assert.throws(
    () => resource([
      "scout:",
      "  resource:",
      "    requirement: required",
      "    requirement: optional",
      "    description: Report.",
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
        "scout:",
        "  resource:",
        "    requirement: required",
        "    description: Report.",
      ], path),
      /resource path/,
      path,
    );
  }
});

test("Scout Skill catalog recursively discovers resources and rejects unlabelled resources", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-skill-resources-"));
  const skillRoot = join(fixtureRoot, "skills", "example");
  const skillPath = join(skillRoot, "SKILL.md");
  const writeResource = (
    path: string,
    requirement: "required" | "optional",
    description: string,
  ): void => {
    mkdirSync(join(skillRoot, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(skillRoot, ...path.split("/")), [
      "---",
      "scout:",
      "  resource:",
      `    requirement: ${requirement}`,
      `    description: ${description}`,
      "---",
    ].join("\n"));
  };

  try {
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(skillPath, scoutSkillText("example"));
    writeResource("templates/report.md", "required", "Report template.");
    writeResource("references/nested/remediation.md", "optional", "Remediation reference.");
    assert.deepEqual(
      buildScoutSkillCatalog({
        assetsRoot: fixtureRoot,
        skillPaths: [join("skills", "example", "SKILL.md")],
      })[0]?.resources,
      [
        {
          path: "references/nested/remediation.md",
          requirement: "optional",
          description: "Remediation reference.",
        },
        {
          path: "templates/report.md",
          requirement: "required",
          description: "Report template.",
        },
      ],
    );

    writeFileSync(join(skillRoot, "templates", "unlabelled.md"), "# Missing metadata\n");
    assert.throws(
      () => buildScoutSkillCatalog({
        assetsRoot: fixtureRoot,
        skillPaths: [join("skills", "example", "SKILL.md")],
      }),
      /must contain YAML frontmatter/,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("Scout Skill catalog rejects resource symlinks and duplicate resource paths", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scout-skill-resource-symlink-"));
  const skillRoot = join(fixtureRoot, "skills", "example");
  try {
    mkdirSync(join(skillRoot, "templates"), { recursive: true });
    writeFileSync(join(skillRoot, "SKILL.md"), scoutSkillText("example"));
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

  const entry = parseMetadata("duplicate-resource");
  entry.resources = [
    {
      path: "templates/report.md",
      requirement: "required",
      description: "First declaration.",
    },
    {
      path: "templates/report.md",
      requirement: "optional",
      description: "Second declaration.",
    },
  ];
  assert.throws(
    () => validateScoutSkillCatalog([entry]),
    /contains duplicate resource path: templates\/report\.md/,
  );

  const legacyEntry = parseMetadata("legacy-resource-catalog") as Partial<ScoutSkillCatalogEntry>;
  delete legacyEntry.resources;
  assert.throws(
    () => validateScoutSkillCatalog([legacyEntry as ScoutSkillCatalogEntry]),
    /must define resources/,
  );

  const invalidEntry = parseMetadata("invalid-resource-catalog");
  invalidEntry.resources = [{
    path: "templates/report.md",
    requirement: "conditional" as "required",
    description: "Report template.",
  }];
  assert.throws(
    () => validateScoutSkillCatalog([invalidEntry]),
    /has unsupported requirement: conditional/,
  );
});

test("Each profile phase projects its routable Skills and dependency closure", () => {
  const profiles = JSON.parse(readFileSync(
    join(assetsRoot, "agents", "agent-profiles.json"),
    "utf8",
  )) as AgentProfilesFile;
  const skillPaths = Object.keys(expectedMetadata).map((name) =>
    join("skills", name, "SKILL.md")
  );
  const catalog = buildScoutSkillCatalog({ assetsRoot, skillPaths });
  const expectedInventories: Record<string, string[]> = {
    coordinator: ["domain-validation-coordinator", "internal-boundary-inspector"],
    researcher: [
      "domain-validation-research-pack",
      "domain-validation-researcher",
      "internal-boundary-inspector",
      "signal-unity-callback-event-by-runtime-log",
      "signal-unity-local-storage",
      "signal-unity-runtime-log",
      "tool-guru-knowledge",
      "tool-jarvis-codebase",
    ],
    verifier: [
      "domain-validation-verifier",
      "internal-boundary-inspector",
      "signal-unity-callback-event-by-runtime-log",
      "signal-unity-local-storage",
      "signal-unity-runtime-log",
      "signal-unity-runtime-log-unity-pipeline-cli",
      "tool-jarvis-codebase",
      "tool-unity-pipeline-cli",
    ],
    validator: [
      "domain-validation-research-pack",
      "domain-validation-validator",
      "domain-validation-verifier",
      "internal-boundary-inspector",
      "signal-unity-callback-event-by-runtime-log",
      "signal-unity-local-storage",
      "signal-unity-runtime-log",
      "signal-unity-runtime-log-unity-pipeline-cli",
      "tool-guru-knowledge",
      "tool-jarvis-codebase",
      "tool-unity-pipeline-cli",
    ],
  };

  for (const [role, profile] of Object.entries(profiles.profiles)) {
    const projected = resolveSkillDependencyLoadOrder(
      catalog,
      catalog
        .filter((skill) => skill.family !== undefined && skill.phase.includes(profile.phase))
        .map((skill) => skill.name),
    );
    assert.deepEqual(
      projected.map((skill) => skill.name).sort(),
      expectedInventories[role]?.sort(),
    );
    assert.ok(projected.every((skill) => skill.phase.includes(profile.phase)));
    assert.equal(projected.some((skill) => skill.name === "internal-skill-creator"), false);
  }
});

test("Scout Skill metadata rejects missing, unsupported, invalid, and duplicate selection tokens", () => {
  assert.throws(
    () => parseMetadata("missing-phase", { phase: null }),
    /must define phase/,
  );
  assert.deepEqual(parseMetadata("off-runtime", { phase: "[]" }).phase, []);
  assert.throws(
    () => parseMetadata("missing-tags", { tags: null }),
    /must define non-empty tags/,
  );
  assert.throws(
    () => parseMetadata("unsupported-phase", { phase: "[deploy]" }),
    /unsupported phase: deploy/,
  );
  assert.throws(
    () => parseMetadata("invalid-family", { family: "[Validation]" }),
    /family has invalid token: Validation/,
  );
  assert.throws(
    () => parseMetadata("duplicate-tag", { tags: "[research, research]" }),
    /tags contains duplicate token: research/,
  );
  assert.throws(
    () => parseMetadata("duplicate-family", { family: "[validation, validation]" }),
    /family contains duplicate token: validation/,
  );
  assert.throws(
    () => parseMetadata("invalid-dependency", { requiredSkills: "[other_skill]" }),
    /dependencies\.skills\.required has invalid token: other_skill/,
  );
  assert.throws(
    () => parseMetadata("legacy-domain", { extraLines: ["domain: [validation]"] }),
    /must use family instead of legacy domain metadata/,
  );
  assert.throws(
    () => parseMetadata("duplicate-field", { extraLines: ["family: [other]"] }),
    /frontmatter contains duplicate field: family/,
  );
  assert.equal(parseMetadata("dependency-only", { family: null }).family, undefined);
});

test("Scout Skill dependency load order is dependency-first and de-duplicated", () => {
  const catalog = [
    parseMetadata("foundation"),
    parseMetadata("producer", { requiredSkills: "[foundation]" }),
    parseMetadata("workflow", { requiredSkills: "[producer, foundation]" }),
    parseMetadata("audit", { requiredSkills: "[foundation]" }),
  ];

  assert.deepEqual(
    resolveSkillDependencyLoadOrder(catalog, ["workflow", "audit"])
      .map((skill) => skill.name),
    ["foundation", "producer", "workflow", "audit"],
  );
});

test("Scout Skill dependencies reject missing entries and cycles", () => {
  assert.throws(
    () => resolveSkillDependencyLoadOrder([
      parseMetadata("workflow", { requiredSkills: "[missing-producer]" }),
    ], ["workflow"]),
    /Unknown Scout Skill dependency: missing-producer/,
  );
  assert.throws(
    () => resolveSkillDependencyLoadOrder([
      parseMetadata("alpha", { requiredSkills: "[beta]" }),
      parseMetadata("beta", { requiredSkills: "[alpha]" }),
    ], ["alpha"]),
    /Scout Skill dependency cycle contains alpha/,
  );
});

test("required Skill dependencies cover every phase of their consumer", () => {
  assert.throws(
    () => validateScoutSkillCatalog([
      parseMetadata("producer", { phase: "[research]" }),
      parseMetadata("workflow", {
        phase: "[research, validate]",
        requiredSkills: "[producer]",
      }),
    ]),
    /dependency producer does not support phase validate/,
  );
  assert.doesNotThrow(() => validateScoutSkillCatalog([
    parseMetadata("producer", {
      phase: "[research, validate]",
      family: null,
    }),
    parseMetadata("workflow", {
      phase: "[research, validate]",
      requiredSkills: "[producer]",
    }),
  ]));
});

test("family paths are routable leaves while family-less Skills require an entry dependency", () => {
  assert.doesNotThrow(() => validateScoutSkillCatalog([
    parseMetadata("service", { family: null }),
    parseMetadata("entry", { requiredSkills: "[service]" }),
  ]));
  assert.doesNotThrow(() => validateScoutSkillCatalog([
    parseMetadata("entry-one", { family: "[catalog, arbitrary-depth]" }),
    parseMetadata("entry-two", { family: "[catalog, arbitrary-depth]" }),
  ]));
  assert.throws(
    () => validateScoutSkillCatalog([
      parseMetadata("orphan-service", { family: null }),
      parseMetadata("entry"),
    ]),
    /orphan-service has no family and is unreachable/,
  );
  assert.throws(
    () => validateScoutSkillCatalog([
      parseMetadata("parent", { family: "[catalog, branch]" }),
      parseMetadata("child", { family: "[catalog, branch, leaf, with, arbitrary, depth]" }),
    ]),
    /family \[catalog, branch\] must be a leaf/,
  );
});

function parseMetadata(
  name: string,
  options: {
    phase?: string | null;
    family?: string | null;
    tags?: string | null;
    requiredSkills?: string;
    extraLines?: string[];
  } = {},
): ScoutSkillCatalogEntry {
  const lines = [
    "assetKind: scout.skill",
    `name: ${name}`,
    "description: Test Scout Skill metadata.",
    `id: ${name}`,
    "version: 1.0.0",
    ...(options.phase === null ? [] : [`phase: ${options.phase ?? "[research]"}`]),
    ...(options.family === null ? [] : [`family: ${options.family ?? `[validation, ${name}]`}`]),
    ...(options.tags === null ? [] : [`tags: ${options.tags ?? "[test]"}`]),
    ...(options.requiredSkills
      ? ["dependencies:", "  skills:", `    required: ${options.requiredSkills}`]
      : []),
    "summary: Test metadata.",
    ...(options.extraLines ?? []),
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
    `family: [validation, ${name}]`,
    "tags: [test]",
    "summary: Test metadata.",
    "---",
    "",
  ].join("\n");
}
