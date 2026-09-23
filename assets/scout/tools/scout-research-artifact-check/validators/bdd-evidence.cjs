const { addIssue } = require("../shared/diagnostics.cjs");
const { bulletFields, displayPath, normalized, scalar, sectionByTitle } = require("../shared/markdown.cjs");
const { validateAggregateBase } = require("./aggregate-state.cjs");

function validateBddEvidence(document, displayRoot, issues) {
  const state = validateAggregateBase(document, "bdd-evidence", displayRoot, issues);
  const path = displayPath(document.path, displayRoot);
  if (scalar(document.frontMatter.evidence_id) !== "E-BDD-001") {
    addIssue(issues, "BDD_AGGREGATE_ID", path, "bdd-evidence.md must own evidence_id E-BDD-001.");
  }
  if (normalized(document.frontMatter.evidence_type) !== "bdd") {
    addIssue(issues, "BDD_AGGREGATE_TYPE", path, "bdd-evidence.md must use evidence_type bdd.");
  }
  if (document.headings.filter((heading) => heading.level === 1 && heading.title === "E-BDD-001").length !== 1) {
    addIssue(issues, "BDD_AGGREGATE_HEADING", path, "bdd-evidence.md must contain exactly one H1 named E-BDD-001.");
  }
  const registration = sectionByTitle(document, 2, "Evidence Registration");
  const fields = registration ? bulletFields(registration.text) : new Map();
  if (scalar(fields.get("evidence_id")) !== "E-BDD-001") {
    addIssue(issues, "BDD_AGGREGATE_BODY_ID", path, "Evidence Registration must declare evidence_id E-BDD-001.");
  }
  if (scalar(fields.get("artifact_ref")) !== "bdd-evidence.md") {
    addIssue(issues, "BDD_AGGREGATE_ARTIFACT_REF", path, "Evidence Registration artifact_ref must equal bdd-evidence.md.");
  }
  return { state };
}

module.exports = { validateBddEvidence };
