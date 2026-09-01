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
  AssetStore,
  buildScoutSkillCatalog,
  listScoutSkillPaths,
  parseScoutSkillMetadata,
  parseScoutSkillResourceMetadata,
  resolveScoutSkillsForPhases,
  resolveSkillDependencyLoadOrder,
  validateScoutSkillCatalog,
  ScoutSkillTypes,
  type ScoutSkillCatalogEntry,
} from "../../src/asset-store/index.js";
import { StartupPhase } from "../../src/core/workflow/index.js";

const scoutRoot = process.cwd();
const assetsRoot = join(scoutRoot, "assets", "codex");

test("every Scout Skill projects the runtime metadata needed by its mount", () => {
  const catalog = buildScoutSkillCatalog({
    assetsRoot,
    skillPaths: listScoutSkillPaths(assetsRoot),
  });
  assert.ok(catalog.length >= 20);
  assert.equal(new Set(catalog.map((skill) => skill.name)).size, catalog.length);
  for (const skill of catalog) {
    assert.ok(Object.values(ScoutSkillTypes).includes(skill.type));
    assert.ok(skill.phase === undefined || Array.isArray(skill.phase));
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
  assert.deepEqual(byName.get("internal-runtime-inspector")?.phase, [StartupPhase]);
  assert.equal(byName.get("internal-skill-creator")?.phase, undefined);
  assert.deepEqual(byName.get("internal-skill-consumption")?.phase, [StartupPhase]);
  assert.deepEqual(byName.get("domain-validation-researcher")?.family, [
    "validation", "workflow",
  ]);
  assert.deepEqual(byName.get("signal-runtime-log")?.family, [
    "signal", "local", "unity", "general",
  ]);
  assert.deepEqual(byName.get("tool-scout-submit-task")?.family, [
    "tool", "scout", "dynamic", "worker",
  ]);
  assert.deepEqual(byName.get("tool-scout-send-message")?.family, [
    "tool", "scout", "dynamic", "general",
  ]);
  assert.deepEqual(byName.get("tool-scout-assign-task")?.family, [
    "tool", "scout", "dynamic", "coordinator",
  ]);
});

test("each Workflow role projects every visible Skill and its dependency closure", () => {
  const graph = new AssetStore().buildWorkflow(scoutRoot, "domain-validation");
  const catalog = buildScoutSkillCatalog({
    assetsRoot,
    skillPaths: listScoutSkillPaths(assetsRoot),
  });
  const expectedInventories: Record<string, string[]> = {
    coordinator: [
      "domain-validation-coordinator",
      "internal-runtime-inspector",
      "internal-skill-consumption",
      "tool-scout-archive-task",
      "tool-scout-assign-task",
      "tool-scout-respond-human-input",
      "tool-scout-send-message",
      "tool-scout-submit-phase-outcome",
    ],
    researcher: [
      "domain-validation-research-pack",
      "domain-validation-researcher",
      "internal-runtime-inspector",
      "internal-skill-consumption",
      "signal-callback-event-by-runtime-log",
      "signal-local-storage",
      "signal-runtime-log",
      "signal-runtime-log-via-unity-pipeline-cli",
      "tool-guru-knowledge",
      "tool-jarvis-codebase",
      "tool-scout-request-human-input",
      "tool-scout-send-message",
      "tool-scout-submit-task",
      "tool-unity-pipeline-cli",
    ],
    verifier: [
      "domain-validation-verifier",
      "internal-runtime-inspector",
      "internal-skill-consumption",
      "signal-callback-event-by-runtime-log",
      "signal-local-storage",
      "signal-runtime-log",
      "signal-runtime-log-via-unity-pipeline-cli",
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
      "internal-runtime-inspector",
      "internal-skill-consumption",
      "signal-callback-event-by-runtime-log",
      "signal-local-storage",
      "signal-runtime-log",
      "signal-runtime-log-via-unity-pipeline-cli",
      "tool-guru-knowledge",
      "tool-jarvis-codebase",
      "tool-scout-request-human-input",
      "tool-scout-send-message",
      "tool-scout-submit-task",
      "tool-unity-pipeline-cli",
    ],
  };

  assert.ok(graph.roles.every((role) => !role.phases.includes(StartupPhase)));

  for (const role of graph.roles) {
    const projected = resolveScoutSkillsForPhases(catalog, role.phases);
    assert.deepEqual(
      projected.map((skill) => skill.name).sort(),
      expectedInventories[role.name]?.sort(),
    );
    assert.ok(projected.every((skill) =>
      skill.phase === undefined
      || skill.phase.includes(StartupPhase)
      || skill.phase.some((phase) => role.phases.includes(phase))
    ));
    assert.equal(projected.some((skill) => skill.name === "internal-skill-creator"), false);
  }

  const startupOnly = resolveScoutSkillsForPhases(catalog, ["future-worker-phase"]);
  assert.deepEqual(startupOnly.map((skill) => skill.name).sort(), [
    "internal-runtime-inspector",
    "internal-skill-consumption",
  ].sort());
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

test("Scout Skill metadata parsing does not enforce type and Phase authoring policy", () => {
  assert.equal(parseMetadata("missing-phase", { phase: null }).phase, undefined);
  assert.deepEqual(parseMetadata("off-runtime", { phase: "[]" }).phase, []);
  assert.throws(() => parseMetadata("missing-family", { family: null }), /must define non-empty family/);
  assert.throws(() => parseMetadata("missing-tags", { tags: null }), /must define non-empty tags/);
  assert.deepEqual(parseMetadata("workflow-phase", { phase: "[Synthesis, deploy]" }).phase, [
    "Synthesis",
    "deploy",
  ]);
  assert.throws(() => parseMetadata("invalid-family", { family: "[Validation]" }), /family has invalid token/);
  assert.throws(() => parseMetadata("duplicate-tag", { tags: "[research, research]" }), /tags contains duplicate token/);
  assert.throws(() => parseMetadata("duplicate-family", { family: "[domain, domain]" }), /family contains duplicate token/);
  assert.throws(
    () => parseMetadata("invalid-dependency", { requiredSkills: "[other_skill]" }),
    /dependencies\.skills\.required has invalid token/,
  );
  assert.equal(parseMetadata("signal-entry", {
    type: "signal",
    phase: null,
  }).type, "signal");
  assert.deepEqual(parseMetadata("signal-with-phase", { type: "signal" }).phase, ["research"]);
  assert.deepEqual(parseMetadata("internal-synthesis", {
    type: "internal",
    phase: "[Synthesis]",
  }).phase, ["Synthesis"]);
});

test("Scout Skill catalog checks cycles while selected dependency loading stays strict", () => {
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
  assert.doesNotThrow(() => validateScoutSkillCatalog([
    parseMetadata("source-authoring-only", {
      type: "internal",
      phase: null,
      requiredSkills: "[unavailable-authoring-dependency]",
    }),
  ]));
  assert.throws(
    () => validateScoutSkillCatalog([
      parseMetadata("alpha", { optionalSkills: "[beta]" }),
      parseMetadata("beta", { requiredSkills: "[alpha]" }),
    ]),
    /dependency cycle/,
  );
  assert.doesNotThrow(() => validateScoutSkillCatalog([
    parseMetadata("producer", { phase: "[research]" }),
    parseMetadata("workflow", { phase: "[research, validate]", requiredSkills: "[producer]" }),
  ]));
  assert.doesNotThrow(() => validateScoutSkillCatalog([
    parseMetadata("startup-foundation", { phase: "[Startup]" }),
    parseMetadata("workflow", {
      phase: "[research, validate]",
      requiredSkills: "[startup-foundation]",
    }),
  ]));
  assert.doesNotThrow(() => validateScoutSkillCatalog([
    parseMetadata("producer", { phase: "[research]" }),
    parseMetadata("startup-workflow", {
      phase: "[Startup]",
      requiredSkills: "[producer]",
    }),
  ]));
  assert.deepEqual(resolveSkillDependencyLoadOrder([
    parseMetadata("foundation"),
    parseMetadata("optional", { type: "signal", phase: null }),
    parseMetadata("workflow", { requiredSkills: "[foundation]", optionalSkills: "[optional]" }),
  ], ["workflow"]).map((skill) => skill.name), ["foundation", "optional", "workflow"]);
  assert.doesNotThrow(() => validateScoutSkillCatalog([
    parseMetadata("workflow", { optionalSkills: "[unavailable-signal]" }),
  ]));
});

test("Scout Skill family paths expand deterministically before dependency traversal", () => {
  const catalog = [
    parseMetadata("signal-general", {
      type: "signal",
      phase: null,
      family: "[signal, local, unity, general]",
    }),
    parseMetadata("signal-special", {
      type: "signal",
      phase: null,
      family: "[signal, local, unity, general, special]",
    }),
    parseMetadata("signal-deep", {
      type: "signal",
      phase: null,
      family: "[signal, local, unity, general, special, deep]",
    }),
    parseMetadata("tool-scout-root", {
      type: "tool",
      phase: null,
      family: "[tool, scout]",
    }),
    parseMetadata("tool-scout-dynamic", {
      type: "tool",
      phase: null,
      family: "[tool, scout, dynamic]",
    }),
    parseMetadata("tool-scout-nested", {
      type: "tool",
      phase: null,
      family: "[tool, scout, dynamic, nested]",
    }),
    parseMetadata("workflow", {
      requiredSkills: "[signal-general, family:signal.local.unity.general.**, family:tool.scout.*]",
      optionalSkills: "[family:missing.optional.**]",
    }),
  ];

  const workflow = catalog.at(-1)!;
  assert.deepEqual(workflow.requiredSkills, ["signal-general"]);
  assert.deepEqual(workflow.requiredFamilyPaths, [{
    family: ["signal", "local", "unity", "general"],
    wildcard: "**",
  }, {
    family: ["tool", "scout"],
    wildcard: "*",
  }]);
  assert.deepEqual(workflow.optionalFamilyPaths, [{
    family: ["missing", "optional"],
    wildcard: "**",
  }]);

  const resolved = resolveSkillDependencyLoadOrder(catalog, ["workflow"]);
  const resolvedWorkflow = resolved.at(-1)!;
  assert.deepEqual(resolvedWorkflow.resolvedRequiredSkills, [
    "signal-general",
    "signal-special",
    "signal-deep",
    "tool-scout-dynamic",
  ]);
  assert.deepEqual(resolvedWorkflow.resolvedOptionalSkills, []);
  assert.deepEqual(resolved.map((skill) => skill.name), [
    "signal-general",
    "signal-special",
    "signal-deep",
    "tool-scout-dynamic",
    "workflow",
  ]);
});

test("selected required family paths reject zero matches and participate in cycle checks", () => {
  const missingFamilyPath = parseMetadata("workflow", {
    requiredSkills: "[family:signal.local.missing.**]",
  });
  assert.doesNotThrow(() => validateScoutSkillCatalog([missingFamilyPath]));
  assert.throws(
    () => resolveSkillDependencyLoadOrder([missingFamilyPath], ["workflow"]),
    /required family path has no matches: signal\.local\.missing\.\*\*/,
  );

  const cyclicCatalog = [
    parseMetadata("alpha", {
      family: "[cycle, alpha]",
      requiredSkills: "[family:cycle.beta.**]",
    }),
    parseMetadata("beta", {
      family: "[cycle, beta]",
      requiredSkills: "[family:cycle.alpha.**]",
    }),
  ];
  assert.throws(() => validateScoutSkillCatalog(cyclicCatalog), /dependency cycle/);
  assert.throws(
    () => parseMetadata("invalid-selector", {
      requiredSkills: "[family:signal.**.invalid]",
    }),
    /dependencies\.skills\.required has invalid token/,
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
    type?: string;
    phase?: string | null;
    family?: string | null;
    tags?: string | null;
    requiredSkills?: string;
    optionalSkills?: string;
  } = {},
): ScoutSkillCatalogEntry {
  const lines = [
    "assetKind: scout.skill",
    `name: ${name}`,
    "description: Test Scout Skill metadata.",
    `type: ${options.type ?? "domain"}`,
    `id: ${name}`,
    "version: 1.0.0",
    ...(options.phase === null ? [] : [`phase: ${options.phase ?? "[research]"}`]),
    ...(options.family === null ? [] : [`family: ${options.family ?? `[test, ${name}]`}`]),
    ...(options.tags === null ? [] : [`tags: ${options.tags ?? "[test]"}`]),
    ...(options.requiredSkills || options.optionalSkills
      ? [
          "dependencies:",
          "  skills:",
          ...(options.requiredSkills ? [`    required: ${options.requiredSkills}`] : []),
          ...(options.optionalSkills ? [`    optional: ${options.optionalSkills}`] : []),
        ]
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
    "type: domain",
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
