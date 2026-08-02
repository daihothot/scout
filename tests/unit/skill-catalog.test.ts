import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildScoutSkillCatalog,
  parseScoutSkillMetadata,
  resolveSkillDependencyLoadOrder,
  validateScoutSkillCatalog,
  type AgentProfilesFile,
  type ScoutSkillCatalogEntry,
} from "../../src/asset-store/index.js";
import {
  ScoutAgentPhases,
  type ScoutAgentRole,
} from "../../src/agent/thread/types.js";

const repoRoot = process.cwd();
const assetsRoot = join(repoRoot, "assets", "codex");

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
    phase: ["coordinate", "research", "verify", "validate"],
    family: ["internal", "skill-creator"],
    tags: ["scout", "skill", "asset", "template", "governance"],
  },
  "signal-unity-callback-event-by-runtime-log": {
    phase: ["research", "verify", "validate"],
    family: ["validation", "signal", "unity-callback-event"],
    tags: ["signal", "unity", "callback", "event", "runtime", "log"],
  },
  "signal-unity-local-storage": {
    phase: ["research", "verify", "validate"],
    family: ["validation", "signal", "unity-local-storage"],
    tags: ["signal", "unity", "local-storage", "sqlite"],
  },
  "signal-unity-runtime-log": {
    phase: ["research", "verify", "validate"],
    family: ["validation", "signal", "unity-runtime-log"],
    tags: ["signal", "unity", "runtime", "log"],
  },
  "signal-unity-runtime-log-unity-pipeline-cli": {
    phase: ["verify", "validate"],
    family: ["validation", "signal", "unity-runtime-log"],
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
  }
});

test("Every profiled Skill supports its agent phase", () => {
  const profiles = JSON.parse(readFileSync(
    join(assetsRoot, "agents", "agent-profiles.json"),
    "utf8",
  )) as AgentProfilesFile;
  const skillPaths = Object.keys(expectedMetadata).map((name) =>
    join("skills", name, "SKILL.md")
  );
  const catalog = buildScoutSkillCatalog({ assetsRoot, skillPaths });
  const byName = new Map(catalog.map((skill) => [skill.name, skill] as const));
  const phases: Record<ScoutAgentRole, ScoutSkillCatalogEntry["phase"][number]> = {
    coordinator: ScoutAgentPhases.Coordinate,
    researcher: ScoutAgentPhases.Research,
    verifier: ScoutAgentPhases.Verify,
    validator: ScoutAgentPhases.Validate,
  };

  for (const [role, profile] of Object.entries(profiles.profiles)) {
    for (const name of profile.skills) {
      const skill = byName.get(name);
      assert.ok(skill, `${role} profile references unknown Skill ${name}`);
      assert.ok(skill.phase.includes(phases[role as ScoutAgentRole]));
    }
  }
});

test("Scout Skill metadata rejects missing, unsupported, invalid, and duplicate selection tokens", () => {
  assert.throws(
    () => parseMetadata("missing-phase", { phase: null }),
    /must define non-empty phase/,
  );
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
    parseMetadata("entry-one", { family: "[validation, signal, runtime-log]" }),
    parseMetadata("entry-two", { family: "[validation, signal, runtime-log]" }),
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
      parseMetadata("parent", { family: "[validation, signal]" }),
      parseMetadata("child", { family: "[validation, signal, runtime-log]" }),
    ]),
    /family \[validation, signal\] must be a leaf/,
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
  });
}
