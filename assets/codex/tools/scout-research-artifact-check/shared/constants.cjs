const EVIDENCE_ID_PATTERN = /^E-(BDD|KB|AVAIL|API|PLATFORM|CG|CODE)-\d+$/;
const EVIDENCE_ID_GLOBAL = /\bE-(?:BDD|KB|AVAIL|API|PLATFORM|CG|CODE)-\d+\b/g;
const STATE_PAIRS = new Set(["draft:partial", "ready:complete", "blocked:blocked"]);

const COVERAGE_DIMENSIONS = [
  "系统目标",
  "系统边界",
  "用户角色",
  "核心能力",
  "关键流程",
  "领域对象",
  "状态变化",
  "业务规则",
  "数据与接口",
  "非功能要求",
  "验收场景",
];

const COVERAGE_STATES = new Set([
  "covered",
  "not_applicable",
  "not_found",
  "needs_confirmation",
]);

const AGGREGATES = {
  index: {
    file: "index.md",
    template: "research-index.md",
    stateHeading: "Research State",
  },
  "bdd-fact": {
    file: "bdd-fact.md",
    template: "bdd-fact.md",
    stateHeading: "Fact State",
  },
  "knowledge-evidence": {
    file: "knowledge-evidence.md",
    template: "knowledge-evidence.md",
    stateHeading: "Knowledge Evidence State",
  },
  "code-evidence": {
    file: "code-evidence.md",
    template: "code-evidence.md",
    stateHeading: "Code Evidence State",
  },
  "evidence-registry": {
    file: "evidence-registry.md",
    template: "evidence-registry.md",
    stateHeading: "Registry State",
  },
  "verification-manual": {
    file: "verification-manual.md",
    template: "verification-manual.md",
    stateHeading: "Manual State",
  },
};

const EVIDENCE_TEMPLATES = {
  BDD: {
    owner: "research",
    template: "bdd-evidence.md",
    evidenceType: "bdd",
    statuses: new Set(["candidate", "ready", "blocked"]),
  },
  KB: {
    owner: "research",
    template: "knowledge-evidence-block.md",
    evidenceType: "knowledge",
    statuses: new Set(["candidate", "ready", "blocked"]),
  },
  AVAIL: {
    owner: "research",
    template: "availability-evidence.md",
    evidenceType: "availability",
    statuses: new Set(["candidate", "ready", "blocked"]),
  },
  API: {
    owner: "research",
    template: "api-evidence.md",
    evidenceType: "api_semantic",
    statuses: new Set(["candidate", "ready", "blocked"]),
  },
  PLATFORM: {
    owner: "research",
    template: "platform-evidence.md",
    evidenceType: "platform_knowledge",
    statuses: new Set(["candidate", "ready", "blocked"]),
  },
  CG: {
    owner: "codebase",
    template: "codegraph-evidence.md",
    evidenceType: "codegraph",
    statuses: new Set(["candidate", "ready", "blocked"]),
  },
  CODE: {
    owner: "codebase",
    template: "source-code-evidence.md",
    evidenceType: "source_code",
    statuses: new Set(["candidate", "source_verified", "blocked"]),
  },
};

module.exports = {
  AGGREGATES,
  COVERAGE_DIMENSIONS,
  COVERAGE_STATES,
  EVIDENCE_ID_GLOBAL,
  EVIDENCE_ID_PATTERN,
  EVIDENCE_TEMPLATES,
  STATE_PAIRS,
};
