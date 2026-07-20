const { validateBddEvidence } = require("./bdd-evidence.cjs");
const { validateCodeEvidence } = require("./code-evidence.cjs");
const { validateEvidenceRegistry } = require("./evidence-registry.cjs");
const { validateKnowledgeEvidence } = require("./knowledge-evidence.cjs");
const { validateVerificationManual } = require("./verification-manual.cjs");

const aggregateValidators = {
  "bdd-evidence": validateBddEvidence,
  "knowledge-evidence": validateKnowledgeEvidence,
  "code-evidence": validateCodeEvidence,
  "evidence-registry": validateEvidenceRegistry,
  "verification-manual": validateVerificationManual,
};

module.exports = { aggregateValidators };
