const { AGGREGATES } = require("../shared/constants.cjs");
const { addIssue } = require("../shared/diagnostics.cjs");
const { bulletFields, displayPath, evidenceIds, markdownTable, normalized, scalar, sectionAt, sectionByTitle } = require("../shared/markdown.cjs");

function validatePackRelations(context) {
  validateRegistryClosure(context);
  validateAggregateEvidenceRefs(context);
  validateCoverageRegistration(context);
  validateImplementationEvidence(context);
  validateManualRegistration(context);
  validateProvenanceConsistency(context);
  validateReadyPack(context);
}

function validateRegistryClosure({ evidence, registryIds, documents, packRoot, issues }) {
  const registry = documents.get("evidence-registry");
  const registryPath = registry ? displayPath(registry.path, packRoot) : AGGREGATES["evidence-registry"].file;
  for (const id of evidence.keys()) {
    if (!registryIds.has(id)) addIssue(issues, "UNREGISTERED_EVIDENCE", `evidence/${id}.md`, `${id} is not registered.`);
  }
  for (const id of registryIds) {
    if (!evidence.has(id)) addIssue(issues, "MISSING_EVIDENCE_ARTIFACT", registryPath, `${id} has no evidence/${id}.md artifact.`);
  }
}

function validateAggregateEvidenceRefs({ documents, registryIds, packRoot, issues }) {
  for (const kind of ["bdd-fact", "knowledge-evidence", "code-evidence", "verification-manual"]) {
    const document = documents.get(kind);
    if (!document) continue;
    for (const id of evidenceIds(document.text)) {
      if (!registryIds.has(id)) {
        addIssue(issues, "UNREGISTERED_EVIDENCE_REF", displayPath(document.path, packRoot), `${id} is referenced but not registered.`);
      }
    }
  }
}

function validateCoverageRegistration({ documents, registryIds, packRoot, issues }) {
  const document = documents.get("knowledge-evidence");
  if (!document) return;
  const section = sectionByTitle(document, 2, "Specification Coverage Matrix");
  const rows = section ? markdownTable(section.text) : [];
  for (const row of rows) {
    for (const id of evidenceIds(row.evidence_refs || "")) {
      if (!registryIds.has(id)) {
        addIssue(issues, "UNREGISTERED_COVERAGE_REF", displayPath(document.path, packRoot), `${row.dimension || "Coverage dimension"} references unregistered ${id}.`);
      }
    }
  }
}

function validateImplementationEvidence({ documents, aggregateResults, evidence, packRoot, issues }) {
  const document = documents.get("code-evidence");
  const state = aggregateResults.get("code-evidence")?.state;
  if (!document || !state || state.status !== "ready") return;
  const section = sectionByTitle(document, 2, "Implementation Claims");
  const rows = section ? markdownTable(section.text) : [];
  const path = displayPath(document.path, packRoot);
  for (const row of rows) {
    for (const id of evidenceIds(row.code_evidence || "")) {
      const artifact = evidence.get(id);
      if (!id.startsWith("E-CODE-") || !artifact || normalized(artifact.frontMatter.status) !== "source_verified") {
        addIssue(issues, "CLAIM_WITHOUT_SOURCE_VERIFIED_EVIDENCE", path, `${row.claim_id || "Implementation claim"} references non-source-verified ${id}.`);
      }
    }
  }
}

function validateManualRegistration({ documents, aggregateResults, registryIds, packRoot, issues }) {
  const document = documents.get("verification-manual");
  if (!document) return;
  const path = displayPath(document.path, packRoot);
  const points = document.headings.filter((heading) => heading.level === 3 && /^VP-\d+\b/.test(heading.title));
  for (const point of points) {
    const pointSection = sectionAt(document, point);
    const fields = bulletFields(pointSection.text);
    const bddRef = scalar(fields.get("bdd_evidence_ref"));
    if (bddRef && !registryIds.has(bddRef)) {
      addIssue(issues, "INVALID_BDD_EVIDENCE_REF", path, `${point.title} requires a registered bdd_evidence_ref.`);
    }
    const supporting = sectionByTitle(pointSection, 4, "Supporting Evidence");
    const refs = supporting ? evidenceIds(supporting.text) : new Set();
    for (const id of refs) {
      if (!registryIds.has(id)) addIssue(issues, "UNREGISTERED_MANUAL_REF", path, `${point.title} references unregistered ${id}.`);
    }
  }
}

function validateProvenanceConsistency({ documents, aggregateResults, evidence, packRoot, issues }) {
  const index = documents.get("index");
  if (!index || aggregateResults.get("index")?.state?.status !== "ready") return;

  const indexRoot = sectionFields(index, "Root Repository Provenance");
  const indexKnowledge = sectionFields(index, "Knowledge Repository Provenance");
  const sourceKeys = new Set(sourceRows(index).map(sourceKey));

  const knowledge = documents.get("knowledge-evidence");
  if (knowledge) compareField(indexKnowledge, sectionFields(knowledge, "Knowledge Repository Provenance"), "knowledge_commit", knowledge, packRoot, issues);

  const code = documents.get("code-evidence");
  if (code) {
    const codeRoot = sectionFields(code, "Root Repository Provenance");
    for (const field of ["root_repo", "root_commit"]) compareField(indexRoot, codeRoot, field, code, packRoot, issues);
    for (const row of sourceRows(code)) {
      const key = sourceKey(row);
      if (!sourceKeys.has(key)) {
        addIssue(issues, "PACK_SOURCE_PROVENANCE_MISMATCH", displayPath(code.path, packRoot), `${key} is not declared in index.md source provenance.`);
      }
    }
  }

  for (const [id, artifact] of evidence) {
    if (!id.startsWith("E-CG-") && !id.startsWith("E-CODE-")) continue;
    const fields = sectionFields(artifact, "Repository Provenance");
    for (const field of ["root_repo", "root_commit"]) compareField(indexRoot, fields, field, artifact, packRoot, issues);
    const key = `${scalar(fields.get("source_repo"))}:${scalar(fields.get("source_commit"))}`;
    if (!sourceKeys.has(key)) {
      addIssue(issues, "EVIDENCE_SOURCE_PROVENANCE_MISMATCH", displayPath(artifact.path, packRoot), `${id} source ${key} is not declared in index.md.`);
    }
  }
}

function validateReadyPack({ documents, aggregateResults, evidence, packRoot, issues }) {
  const indexState = aggregateResults.get("index")?.state;
  if (!indexState || indexState.status !== "ready") return;
  for (const [kind, config] of Object.entries(AGGREGATES)) {
    const state = aggregateResults.get(kind)?.state;
    if (!state || state.status !== "ready" || state.completionState !== "complete") {
      addIssue(issues, "READY_PACK_INCOMPLETE", config.file, "A ready index requires every aggregate artifact to be ready + complete.");
    }
  }
  for (const [id, artifact] of evidence) {
    const expectedStatus = id.startsWith("E-CODE-") ? "source_verified" : "ready";
    if (normalized(artifact.frontMatter.status) !== expectedStatus) {
      addIssue(issues, "READY_PACK_EVIDENCE_NOT_READY", displayPath(artifact.path, packRoot), `A ready pack requires ${id} status: ${expectedStatus}.`);
    }
  }
}

function compareField(expected, actual, field, document, packRoot, issues) {
  const expectedValue = scalar(expected.get(field));
  const actualValue = scalar(actual.get(field));
  if (expectedValue !== actualValue) {
    addIssue(issues, "PACK_PROVENANCE_MISMATCH", displayPath(document.path, packRoot), `${field} must match index.md (${expectedValue}).`);
  }
}

function sourceRows(document) {
  const section = sectionByTitle(document, 2, "Source Repository Provenance");
  return section ? markdownTable(section.text) : [];
}

function sectionFields(document, title) {
  const section = sectionByTitle(document, 2, title);
  return section ? bulletFields(section.text) : new Map();
}

function sourceKey(row) {
  return `${scalar(row.source_repo)}:${scalar(row.source_commit)}`;
}

module.exports = { validatePackRelations };
