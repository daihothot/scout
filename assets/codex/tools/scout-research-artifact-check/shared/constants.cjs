const EVIDENCE_ID_PATTERN = /^E-(BDD|KB|CAP|AVAIL|PLATFORM|PERSONA|HUMAN|CODE)-\d+$/;
const EVIDENCE_ID_GLOBAL = /\bE-(?:BDD|KB|CAP|AVAIL|API|PLATFORM|PERSONA|HUMAN|CODE)-\d+\b/g;
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
  "bdd-evidence": {
    file: "bdd-evidence.md",
    template: "bdd-evidence.md",
    stateHeading: "Evidence State",
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
  CAP: {
    owner: "knowledge",
    template: "capability-evidence.md",
    evidenceType: "capability",
    statuses: new Set(["candidate", "ready", "blocked"]),
  },
  AVAIL: {
    owner: "knowledge",
    template: "availability-evidence.md",
    evidenceType: "availability",
    statuses: new Set(["candidate", "ready", "blocked"]),
  },
  PLATFORM: {
    owner: "knowledge",
    template: "platform-evidence.md",
    evidenceType: "platform_knowledge",
    statuses: new Set(["candidate", "ready", "blocked"]),
  },
  PERSONA: {
    owner: "research",
    template: "user-persona-evidence.md",
    evidenceType: "user_persona",
    statuses: new Set(["candidate", "ready", "blocked"]),
  },
  HUMAN: {
    owner: "research",
    template: "human-confirmation-evidence.md",
    evidenceType: "human_confirmation",
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
