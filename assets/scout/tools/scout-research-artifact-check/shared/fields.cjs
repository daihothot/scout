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

function codebaseFields() {
  return [
    "codebase",
    "version",
    "codegraph_status",
  ];
}

function concreteCodebaseFields() {
  return [
    "codebase",
    "version",
    "codegraph_status",
  ];
}

module.exports = {
  codebaseFields,
  concreteCodebaseFields,
  requireNonNoneFields,
  requireSectionFields,
};
