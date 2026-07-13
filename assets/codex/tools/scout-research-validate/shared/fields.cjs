const { addIssue } = require("./diagnostics.cjs");
const { bulletFields, displayPath, isNone, isPlaceholder, sectionByTitle } = require("./markdown.cjs");

function requireSectionFields(document, title, names, displayRoot, issues) {
  const section = sectionByTitle(document, 2, title);
  if (!section) return undefined;
  const fields = bulletFields(section.text);
  for (const name of names) {
    if (isPlaceholder(fields.get(name))) {
      addIssue(issues, "REQUIRED_FIELD_MISSING", displayPath(document.path, displayRoot), `${title}.${name} is required.`);
    }
  }
  return fields;
}

function requireNonNoneFields(document, title, fields, names, displayRoot, issues) {
  if (!fields) return;
  for (const name of names) {
    if (isNone(fields.get(name))) {
      addIssue(issues, "REQUIRED_FIELD_NONE", displayPath(document.path, displayRoot), `${title}.${name} cannot be none.`);
    }
  }
}

function repositoryFields() {
  return [
    "root_repo",
    "root_version",
    "root_branch",
    "root_commit",
    "root_worktree_state",
    "root_codebase_path",
    "source_repo",
    "source_version",
    "source_branch",
    "source_commit",
    "source_worktree_state",
    "source_codebase_path",
    "gitlink_path",
    "gitlink_commit",
    "gitlink_matches_source_commit",
    "codegraph_status",
  ];
}

function concreteRepositoryFields() {
  return [
    "root_repo",
    "root_commit",
    "root_codebase_path",
    "source_repo",
    "source_commit",
    "source_codebase_path",
    "codegraph_status",
  ];
}

module.exports = {
  concreteRepositoryFields,
  repositoryFields,
  requireNonNoneFields,
  requireSectionFields,
};
