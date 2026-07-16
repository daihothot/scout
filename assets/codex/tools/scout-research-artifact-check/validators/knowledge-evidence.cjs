const { COVERAGE_DIMENSIONS, COVERAGE_STATES } = require("../shared/constants.cjs");
const { addIssue } = require("../shared/diagnostics.cjs");
const { displayPath, evidenceIds, isPlaceholder, markdownTable, normalized, scalar, sectionByTitle } = require("../shared/markdown.cjs");
const { validateAggregateBase } = require("./aggregate-state.cjs");

function validateKnowledgeEvidence(document, displayRoot, issues) {
  const state = validateAggregateBase(document, "knowledge-evidence", displayRoot, issues);
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
    if (coverageState === "covered" && evidenceIds(row.evidence_refs || "").size === 0) {
      addIssue(issues, "COVERED_WITHOUT_EVIDENCE", path, `${dimension} is covered but has no evidence_refs.`);
    }
    if (coverageState !== "covered" && isPlaceholder(row.gap_or_rationale)) {
      addIssue(issues, "COVERAGE_GAP_MISSING", path, `${dimension} requires gap_or_rationale for ${coverageState || "<empty>"}.`);
    }
  }
  return { state };
}

module.exports = { validateKnowledgeEvidence };
