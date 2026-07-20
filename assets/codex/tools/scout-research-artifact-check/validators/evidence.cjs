const { basename, isAbsolute } = require("node:path");
const { COVERAGE_DIMENSIONS, COVERAGE_STATES, EVIDENCE_ID_PATTERN, EVIDENCE_TEMPLATES } = require("../shared/constants.cjs");
const { addIssue } = require("../shared/diagnostics.cjs");
const { concreteRepositoryFields, repositoryFields, requireNonNoneFields, requireSectionFields } = require("../shared/fields.cjs");
const { bulletFields, displayPath, evidenceIds, hasTemplateInstruction, isPlaceholder, markdownTable, normalized, scalar, sectionByTitle } = require("../shared/markdown.cjs");
const { codebaseTemplatePath, researchTemplatePath, validateTemplateSections } = require("../shared/templates.cjs");

function validateEvidence(document, displayRoot, issues) {
  const id = scalar(document.frontMatter.evidence_id);
  const path = displayPath(document.path, displayRoot);
  if (!EVIDENCE_ID_PATTERN.test(id)) {
    addIssue(issues, "INVALID_EVIDENCE_ID", path, `Invalid evidence id: ${id || "<empty>"}.`);
    return { evidenceId: id };
  }

  const [, kind] = id.match(EVIDENCE_ID_PATTERN);
  if (kind === "BDD") {
    addIssue(issues, "BDD_AGGREGATE_FILE_FORBIDDEN", path, "E-BDD-001 is owned by bdd-evidence.md and must not exist under evidence/.");
    return { evidenceId: id, kind, status: normalized(document.frontMatter.status) };
  }
  if (kind === "KB") {
    addIssue(issues, "KNOWLEDGE_AGGREGATE_FILE_FORBIDDEN", path, "E-KB-001 is owned by knowledge-evidence.md and must not exist under evidence/.");
    return { evidenceId: id, kind, status: normalized(document.frontMatter.status) };
  }
  const config = EVIDENCE_TEMPLATES[kind];
  const expectedFile = `${id}.md`;
  if (basename(document.path) !== expectedFile) {
    addIssue(issues, "EVIDENCE_FILENAME_MISMATCH", path, `Expected filename ${expectedFile}.`);
  }
  if (document.headings.filter((heading) => heading.level === 1 && heading.title === id).length !== 1) {
    addIssue(issues, "EVIDENCE_HEADING_MISMATCH", path, `Expected exactly one H1 named ${id}.`);
  }
  if (normalized(document.frontMatter.evidence_type) !== config.evidenceType) {
    addIssue(issues, "EVIDENCE_TYPE_MISMATCH", path, `Expected evidence_type ${config.evidenceType}.`);
  }

  const status = normalized(document.frontMatter.status);
  if (!config.statuses.has(status)) {
    addIssue(issues, "INVALID_EVIDENCE_STATUS", path, `Invalid evidence status: ${status || "<empty>"}.`);
  }
  const artifactState = sectionByTitle(document, 2, "Artifact State");
  const bodyStatus = artifactState ? normalized(bulletFields(artifactState.text).get("status")) : "";
  if (bodyStatus !== status) {
    addIssue(issues, "EVIDENCE_STATUS_MISMATCH", path, "Frontmatter and Artifact State status must match.");
  }
  if (["ready", "source_verified"].includes(status) && hasTemplateInstruction(document.text)) {
    addIssue(issues, "TEMPLATE_INSTRUCTION_REMAINS", path, "completed evidence cannot retain template fill instructions.");
  }

  const templatePath = config.owner === "research"
    ? researchTemplatePath(config.template)
    : codebaseTemplatePath(config.template);
  validateTemplateSections(document, templatePath, displayRoot, issues);

  if (kind === "CAP") validateCapabilityEvidence(document, displayRoot, issues);
  if (kind === "AVAIL" && id !== "E-AVAIL-001") {
    addIssue(issues, "AVAILABILITY_SINGLETON_ID", path, "A Research pack permits only E-AVAIL-001.");
  }
  if (kind === "PLATFORM" && id !== "E-PLATFORM-001") {
    addIssue(issues, "PLATFORM_SINGLETON_ID", path, "A Research pack permits only E-PLATFORM-001.");
  }
  if (kind === "PERSONA") validateUserPersonaEvidence(document, status, displayRoot, issues);
  if (kind === "HUMAN") validateHumanConfirmationEvidence(document, status, displayRoot, issues);
  if (kind === "CODE") validateSourceCodeEvidence(document, status, displayRoot, issues);
  return { evidenceId: id, kind, status };
}

function validateCapabilityEvidence(document, displayRoot, issues) {
  const path = displayPath(document.path, displayRoot);
  const section = sectionByTitle(document, 2, "Specification Coverage Matrix");
  const rows = section ? markdownTable(section.text) : [];
  const byDimension = new Map();

  for (const row of rows) {
    const dimension = scalar(row.dimension);
    if (byDimension.has(dimension)) {
      addIssue(issues, "DUPLICATE_COVERAGE_DIMENSION", path, `Duplicate coverage dimension: ${dimension}.`);
    }
    byDimension.set(dimension, row);
  }

  for (const dimension of COVERAGE_DIMENSIONS) {
    const row = byDimension.get(dimension);
    if (!row) {
      addIssue(issues, "COVERAGE_DIMENSION_MISSING", path, `Missing coverage dimension: ${dimension}.`);
      continue;
    }
    const coverageState = normalized(row.coverage_state);
    if (!COVERAGE_STATES.has(coverageState)) {
      addIssue(issues, "INVALID_COVERAGE_STATE", path, `${dimension} has invalid coverage_state: ${coverageState || "<empty>"}.`);
    }
    if (coverageState === "covered" && (isPlaceholder(row.claim) || isPlaceholder(row.source_refs))) {
      addIssue(issues, "COVERED_WITHOUT_SOURCE", path, `${dimension} is covered but has no concrete claim or source_refs.`);
    }
    if (coverageState !== "covered" && isPlaceholder(row.gap_or_rationale)) {
      addIssue(issues, "COVERAGE_GAP_MISSING", path, `${dimension} requires gap_or_rationale for ${coverageState || "<empty>"}.`);
    }
  }
}

function validateSourceCodeEvidence(document, status, displayRoot, issues) {
  const path = displayPath(document.path, displayRoot);
  const provenance = requireSectionFields(document, "Repository Provenance", repositoryFields(), displayRoot, issues);
  requireNonNoneFields(document, "Repository Provenance", provenance, concreteRepositoryFields(), displayRoot, issues);
  const replay = requireSectionFields(document, "Replay Locator", [
    "source_relative_file",
    "source_file_worktree_state",
    "canonical_locator",
  ], displayRoot, issues);
  requireSectionFields(document, "Primary Symbol", [
    "name",
    "type",
    "start_line",
    "end_line",
    "signature",
  ], displayRoot, issues);
  requireSectionFields(document, "Collection", [
    "method",
    "query_result_summary",
  ], displayRoot, issues);

  const primarySymbolCount = document.headings.filter((heading) => heading.level === 2 && heading.title === "Primary Symbol").length;
  if (primarySymbolCount !== 1) {
    addIssue(issues, "PRIMARY_SYMBOL_COUNT", path, "Each E-CODE artifact must contain exactly one Primary Symbol section.");
  }

  const sourceFile = replay && scalar(replay.get("source_relative_file"));
  const sourceCommit = provenance && scalar(provenance.get("source_commit"));
  if (sourceFile && (isAbsolute(sourceFile) || sourceFile.split(/[\\/]/).includes(".."))) {
    addIssue(issues, "INVALID_SOURCE_RELATIVE_FILE", path, "source_relative_file must be relative to the source repository.");
  }
  if (sourceFile && sourceCommit) {
    const expected = `${sourceCommit}:${sourceFile}`;
    if (scalar(replay.get("canonical_locator")) !== expected) {
      addIssue(issues, "INVALID_CANONICAL_LOCATOR", path, `canonical_locator must equal ${expected}.`);
    }
  }

  if (status !== "source_verified") return;
  if (normalized(replay && replay.get("source_file_worktree_state")) !== "clean") {
    addIssue(issues, "SOURCE_FILE_NOT_CLEAN", path, "source_verified requires source_file_worktree_state: clean.");
  }
  const gitlinkPath = scalar(provenance && provenance.get("gitlink_path"));
  const gitlinkCommit = scalar(provenance && provenance.get("gitlink_commit"));
  if ((gitlinkPath === "none") !== (gitlinkCommit === "none")) {
    addIssue(issues, "INCOMPLETE_GITLINK", path, "gitlink_path and gitlink_commit must both be none or both be concrete.");
  }
  if (gitlinkPath !== "none" && (gitlinkCommit !== sourceCommit || normalized(provenance.get("gitlink_matches_source_commit")) !== "true")) {
    addIssue(issues, "GITLINK_COMMIT_MISMATCH", path, "source_verified nested evidence requires gitlink_commit to equal source_commit.");
  }
}

function validateHumanConfirmationEvidence(document, status, displayRoot, issues) {
  if (status !== "ready") return;
  requireNonNoneFields(document, "Human Confirmation Source", requireSectionFields(document, "Human Confirmation Source", [
    "source_type",
    "task_id",
    "source_locator",
  ], displayRoot, issues), [
    "source_type",
    "task_id",
    "source_locator",
  ], displayRoot, issues);
  requireNonNoneFields(document, "Confirmed Fact", requireSectionFields(document, "Confirmed Fact", [
    "field",
    "value",
    "applies_to",
  ], displayRoot, issues), [
    "field",
    "value",
    "applies_to",
  ], displayRoot, issues);
}

function validateUserPersonaEvidence(document, status, displayRoot, issues) {
  if (status !== "ready") return;
  requireNonNoneFields(document, "Persona Identity", requireSectionFields(document, "Persona Identity", [
    "persona_id",
  ], displayRoot, issues), [
    "persona_id",
  ], displayRoot, issues);
  requireNonNoneFields(document, "Persona Facts", requireSectionFields(document, "Persona Facts", [
    "account_state",
    "platform",
    "app_version",
  ], displayRoot, issues), [
    "account_state",
    "platform",
    "app_version",
  ], displayRoot, issues);
  const sourceEvidence = sectionByTitle(document, 2, "Source Evidence");
  const refs = sourceEvidence ? evidenceIds(sourceEvidence.text) : new Set();
  if (![...refs].some((id) => /^(?:E-BDD|E-CAP|E-HUMAN)-\d+$/.test(id) || id === "E-KB-001")) {
    addIssue(issues, "PERSONA_SOURCE_EVIDENCE_MISSING", displayPath(document.path, displayRoot), "ready user persona evidence requires an E-BDD, E-KB-001, E-CAP, or E-HUMAN source evidence ref.");
  }
}

module.exports = { validateEvidence };
