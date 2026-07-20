const { EVIDENCE_ID_PATTERN } = require("../shared/constants.cjs");
const { addIssue } = require("../shared/diagnostics.cjs");
const { bulletFields, displayPath, isPlaceholder, scalar, sectionAt } = require("../shared/markdown.cjs");
const { validateAggregateBase } = require("./aggregate-state.cjs");

function validateEvidenceRegistry(document, displayRoot, issues) {
  const state = validateAggregateBase(document, "evidence-registry", displayRoot, issues);
  const registryIds = new Set();
  const path = displayPath(document.path, displayRoot);

  for (const heading of document.headings.filter((item) => item.level === 3 && EVIDENCE_ID_PATTERN.test(item.title))) {
    if (registryIds.has(heading.title)) {
      addIssue(issues, "DUPLICATE_REGISTRY_ID", path, `Duplicate registry id: ${heading.title}.`);
    }
    registryIds.add(heading.title);
    const fields = bulletFields(sectionAt(document, heading).text);
    const expectedRef = heading.title === "E-BDD-001"
      ? "bdd-evidence.md"
      : heading.title === "E-KB-001"
        ? "knowledge-evidence.md"
        : `evidence/${heading.title}.md`;
    if (scalar(fields.get("artifact_ref")) !== expectedRef) {
      addIssue(issues, "REGISTRY_ARTIFACT_REF", path, `${heading.title} artifact_ref must equal ${expectedRef}.`);
    }
    if (heading.title.startsWith("E-KB-") && heading.title !== "E-KB-001") {
      addIssue(issues, "KNOWLEDGE_AGGREGATE_ID", path, "The registry permits only the E-KB-001 knowledge aggregate.");
    }
    if (heading.title.startsWith("E-BDD-") && heading.title !== "E-BDD-001") {
      addIssue(issues, "BDD_AGGREGATE_ID", path, "The registry permits only the E-BDD-001 BDD aggregate.");
    }
    for (const field of ["source", "locator", "claim_supported", "supports"]) {
      if (isPlaceholder(fields.get(field))) {
        addIssue(issues, "REGISTRY_FIELD_MISSING", path, `${heading.title} is missing ${field}.`);
      }
    }
  }
  return { state, registryIds };
}

module.exports = { validateEvidenceRegistry };
