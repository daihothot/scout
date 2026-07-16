const { addIssue } = require("../shared/diagnostics.cjs");
const { requireNonNoneFields, requireSectionFields } = require("../shared/fields.cjs");
const { displayPath, isNone, isPlaceholder, markdownTable, sectionByTitle } = require("../shared/markdown.cjs");
const { validateAggregateBase } = require("./aggregate-state.cjs");

function validateResearchIndex(document, displayRoot, issues) {
  const state = validateAggregateBase(document, "index", displayRoot, issues);
  if (!state || state.status !== "ready") return { state };

  const knowledge = requireSectionFields(document, "Knowledge Repository Provenance", [
    "knowledge_repo",
    "knowledge_branch",
    "knowledge_commit",
    "knowledge_worktree_state",
    "knowledge_root",
  ], displayRoot, issues);
  const root = requireSectionFields(document, "Root Repository Provenance", [
    "root_repo",
    "root_version",
    "root_branch",
    "root_commit",
    "root_worktree_state",
    "root_codebase_path",
  ], displayRoot, issues);
  requireSectionFields(document, "Collection Provenance", [
    "codegraph_project_root",
    "codegraph_status",
  ], displayRoot, issues);
  requireNonNoneFields(document, "Knowledge Repository Provenance", knowledge, [
    "knowledge_repo",
    "knowledge_commit",
    "knowledge_root",
  ], displayRoot, issues);
  requireNonNoneFields(document, "Root Repository Provenance", root, [
    "root_repo",
    "root_commit",
    "root_codebase_path",
  ], displayRoot, issues);

  const sourceSection = sectionByTitle(document, 2, "Source Repository Provenance");
  const sourceRows = sourceSection ? markdownTable(sourceSection.text) : [];
  const path = displayPath(document.path, displayRoot);
  if (sourceRows.length === 0) {
    addIssue(issues, "SOURCE_PROVENANCE_MISSING", path, "At least one source repository provenance row is required.");
  }
  for (const row of sourceRows) {
    for (const field of ["source_id", "source_repo", "source_version", "source_branch", "source_commit", "source_worktree_state", "source_codebase_path", "gitlink_path", "gitlink_commit", "codegraph_status"]) {
      if (isPlaceholder(row[field])) addIssue(issues, "SOURCE_PROVENANCE_FIELD_MISSING", path, `Source repository row is missing ${field}.`);
    }
    for (const field of ["source_id", "source_repo", "source_commit", "source_codebase_path", "codegraph_status"]) {
      if (isNone(row[field])) addIssue(issues, "SOURCE_PROVENANCE_FIELD_INVALID", path, `Source repository ${field} cannot be none.`);
    }
  }
  return { state };
}

module.exports = { validateResearchIndex };
