const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { addIssue } = require("./diagnostics.cjs");
const { displayPath, parseMarkdown } = require("./markdown.cjs");

function researchTemplatePath(file) {
  return join(__dirname, "..", "..", "..", "skills", "guru-knowledge-research", "templates", file);
}

function codebaseTemplatePath(file) {
  return join(__dirname, "..", "..", "..", "skills", "jarvis-codebase", "templates", file);
}

function validateTemplateSections(document, templatePath, displayRoot, issues) {
  if (!existsSync(templatePath)) {
    addIssue(issues, "TEMPLATE_NOT_FOUND", templatePath, "Applicable template is missing.");
    return;
  }
  const template = parseMarkdown(templatePath, readFileSync(templatePath, "utf8"));
  const required = template.headings.filter((heading) => heading.level === 2).map((heading) => heading.title);
  const actual = new Set(document.headings.filter((heading) => heading.level === 2).map((heading) => heading.title));
  for (const title of required) {
    if (!actual.has(title)) {
      addIssue(issues, "TEMPLATE_SECTION_MISSING", displayPath(document.path, displayRoot), `Missing applicable template section: ${title}.`);
    }
  }
}

module.exports = {
  codebaseTemplatePath,
  researchTemplatePath,
  validateTemplateSections,
};
