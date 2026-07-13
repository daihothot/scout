const { addIssue } = require("../shared/diagnostics.cjs");
const { displayPath, evidenceIds, markdownTable, sectionByTitle } = require("../shared/markdown.cjs");
const { validateAggregateBase } = require("./aggregate-state.cjs");

function validateCodeEvidence(document, displayRoot, issues) {
  const state = validateAggregateBase(document, "code-evidence", displayRoot, issues);
  if (!state || state.status !== "ready") return { state };

  const path = displayPath(document.path, displayRoot);
  const section = sectionByTitle(document, 2, "Implementation Claims");
  const rows = section ? markdownTable(section.text) : [];
  if (rows.length === 0) {
    addIssue(issues, "IMPLEMENTATION_CLAIMS_MISSING", path, "ready + complete code evidence requires implementation claims.");
  }
  for (const row of rows) {
    const ids = [...evidenceIds(row.code_evidence || "")];
    if (!ids.some((id) => id.startsWith("E-CODE-"))) {
      addIssue(issues, "CLAIM_WITHOUT_CODE_EVIDENCE", path, `${row.claim_id || "Implementation claim"} has no E-CODE evidence.`);
    }
  }
  return { state };
}

module.exports = { validateCodeEvidence };
