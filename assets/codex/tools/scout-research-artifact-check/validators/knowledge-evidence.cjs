const { addIssue } = require("../shared/diagnostics.cjs");
const { bulletFields, displayPath, normalized, scalar, sectionByTitle } = require("../shared/markdown.cjs");
const { validateAggregateBase } = require("./aggregate-state.cjs");

function validateKnowledgeEvidence(document, displayRoot, issues) {
  const state = validateAggregateBase(document, "knowledge-evidence", displayRoot, issues);
  const path = displayPath(document.path, displayRoot);
  if (scalar(document.frontMatter.evidence_id) !== "E-KB-001") {
    addIssue(issues, "KNOWLEDGE_AGGREGATE_ID", path, "knowledge-evidence.md must own evidence_id E-KB-001.");
  }
  if (normalized(document.frontMatter.evidence_type) !== "knowledge_aggregate") {
    addIssue(issues, "KNOWLEDGE_AGGREGATE_TYPE", path, "knowledge-evidence.md must use evidence_type knowledge_aggregate.");
  }
  const aggregate = sectionByTitle(document, 2, "Knowledge Aggregate");
  if (scalar(aggregate && bulletFields(aggregate.text).get("evidence_id")) !== "E-KB-001") {
    addIssue(issues, "KNOWLEDGE_AGGREGATE_BODY_ID", path, "Knowledge Aggregate must declare evidence_id E-KB-001.");
  }
  return { state };
}

module.exports = { validateKnowledgeEvidence };
