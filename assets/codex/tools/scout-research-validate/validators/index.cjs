const { validateBddFact } = require("./bdd-fact.cjs");
const { validateCodeEvidence } = require("./code-evidence.cjs");
const { validateEvidenceRegistry } = require("./evidence-registry.cjs");
const { validateKnowledgeEvidence } = require("./knowledge-evidence.cjs");
const { validateResearchIndex } = require("./research-index.cjs");
const { validateVerificationManual } = require("./verification-manual.cjs");

const aggregateValidators = {
  index: validateResearchIndex,
  "bdd-fact": validateBddFact,
  "knowledge-evidence": validateKnowledgeEvidence,
  "code-evidence": validateCodeEvidence,
  "evidence-registry": validateEvidenceRegistry,
  "verification-manual": validateVerificationManual,
};

module.exports = { aggregateValidators };
