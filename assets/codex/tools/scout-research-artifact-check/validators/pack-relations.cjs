const { AGGREGATES } = require("../shared/constants.cjs");
const { addIssue } = require("../shared/diagnostics.cjs");
const { bulletFields, displayPath, evidenceIds, markdownTable, normalized, scalar, sectionAt, sectionByTitle } = require("../shared/markdown.cjs");

function validatePackRelations(context) {
  validateRemovedEvidenceRefs(context);
  validateRegistryClosure(context);
  validateAggregateEvidenceRefs(context);
  validateSingletonKnowledgeEvidence(context);
  validateKnowledgeAggregation(context);
  validateImplementationEvidence(context);
  validateManualRegistration(context);
  validateProvenanceConsistency(context);
  validateReadyPack(context);
}

function validateRemovedEvidenceRefs({ documents, evidence, packRoot, issues }) {
  for (const document of [...documents.values(), ...evidence.values()]) {
    for (const id of new Set(document.text.match(/\bE-CG-\d+\b/g) || [])) {
      addIssue(issues, "REMOVED_CODEGRAPH_EVIDENCE_REF", displayPath(document.path, packRoot), `${id} is removed; CodeGraph queries belong in E-CODE Collection provenance.`);
    }
    for (const id of new Set(document.text.match(/\bE-API-\d+\b/g) || [])) {
      addIssue(issues, "REMOVED_API_EVIDENCE_REF", displayPath(document.path, packRoot), `${id} is removed; API documents belong in E-CAP Source Refs and the 数据与接口 dimension.`);
    }
  }
}

function validateRegistryClosure({ evidence, registryIds, documents, packRoot, issues }) {
  const registry = documents.get("evidence-registry");
  const registryPath = registry ? displayPath(registry.path, packRoot) : AGGREGATES["evidence-registry"].file;
  for (const [id, artifact] of evidence) {
    if (!registryIds.has(id)) addIssue(issues, "UNREGISTERED_EVIDENCE", `evidence/${id}.md`, `${id} is not registered.`);
    if (id.startsWith("E-PERSONA-")) {
      const sourceEvidence = sectionByTitle(artifact, 2, "Source Evidence");
      for (const sourceId of sourceEvidence ? evidenceIds(sourceEvidence.text) : []) {
        if (!registryIds.has(sourceId)) {
          addIssue(issues, "UNREGISTERED_PERSONA_SOURCE_REF", displayPath(artifact.path, packRoot), `${id} references unregistered ${sourceId}.`);
        }
      }
    }
  }
  for (const id of registryIds) {
    if (id === "E-BDD-001") {
      if (!documents.has("bdd-evidence")) addIssue(issues, "MISSING_BDD_AGGREGATE", registryPath, "E-BDD-001 requires bdd-evidence.md.");
      continue;
    }
    if (id === "E-KB-001") {
      if (!documents.has("knowledge-evidence")) addIssue(issues, "MISSING_KNOWLEDGE_AGGREGATE", registryPath, "E-KB-001 requires knowledge-evidence.md.");
      continue;
    }
    if (!evidence.has(id)) addIssue(issues, "MISSING_EVIDENCE_ARTIFACT", registryPath, `${id} has no evidence/${id}.md artifact.`);
  }
}

function validateAggregateEvidenceRefs({ documents, registryIds, packRoot, issues }) {
  for (const kind of ["bdd-evidence", "knowledge-evidence", "code-evidence", "verification-manual"]) {
    const document = documents.get(kind);
    if (!document) continue;
    for (const id of evidenceIds(document.text)) {
      if (!registryIds.has(id)) {
        addIssue(issues, "UNREGISTERED_EVIDENCE_REF", displayPath(document.path, packRoot), `${id} is referenced but not registered.`);
      }
    }
  }
}

function validateSingletonKnowledgeEvidence({ evidence, registryIds, documents, packRoot, issues }) {
  const knowledge = documents.get("knowledge-evidence");
  const path = knowledge ? displayPath(knowledge.path, packRoot) : AGGREGATES["knowledge-evidence"].file;
  if (!registryIds.has("E-KB-001")) {
    addIssue(issues, "KNOWLEDGE_AGGREGATE_NOT_REGISTERED", path, "knowledge-evidence.md must be registered as E-KB-001.");
  }
  for (const id of ["E-AVAIL-001", "E-PLATFORM-001"]) {
    if (!evidence.has(id)) {
      addIssue(issues, "SINGLETON_EVIDENCE_MISSING", path, `${id} is required exactly once in every Research pack.`);
    }
  }
}

function validateKnowledgeAggregation({ evidence, registryIds, documents, packRoot, issues }) {
  const knowledge = documents.get("knowledge-evidence");
  if (!knowledge) return;
  const path = displayPath(knowledge.path, packRoot);
  const aggregateRefs = evidenceIds(knowledge.text);
  for (const id of registryIds) {
    if (/^E-(?:BDD|CAP|AVAIL|PLATFORM)-\d+$/.test(id) && !aggregateRefs.has(id)) {
      addIssue(issues, "KNOWLEDGE_AGGREGATE_REF_MISSING", path, `knowledge-evidence.md does not aggregate registered ${id}.`);
    }
  }

  const capabilityIds = [...evidence.keys()].filter((id) => id.startsWith("E-CAP-"));
  for (const [id, sectionTitle] of [["E-AVAIL-001", "Availability Scope"], ["E-PLATFORM-001", "Platform Scope"]]) {
    const artifact = evidence.get(id);
    if (!artifact) continue;
    const section = sectionByTitle(artifact, 2, sectionTitle);
    const refs = section ? evidenceIds(section.text) : new Set();
    for (const capabilityId of capabilityIds) {
      if (!refs.has(capabilityId)) {
        addIssue(issues, "CAPABILITY_AGGREGATE_REF_MISSING", displayPath(artifact.path, packRoot), `${id} does not include ${capabilityId} in capability_refs.`);
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
    const personaEvidenceRef = scalar(fields.get("persona_evidence_ref"));
    if (bddRef && !registryIds.has(bddRef)) {
      addIssue(issues, "INVALID_BDD_EVIDENCE_REF", path, `${point.title} requires a registered bdd_evidence_ref.`);
    }
    if (personaEvidenceRef && (!personaEvidenceRef.startsWith("E-PERSONA-") || !registryIds.has(personaEvidenceRef))) {
      addIssue(issues, "INVALID_PERSONA_EVIDENCE_REF", path, `${point.title} requires a registered E-PERSONA persona_evidence_ref.`);
    }
    const supporting = sectionByTitle(pointSection, 4, "Supporting Evidence");
    const refs = supporting ? evidenceIds(supporting.text) : new Set();
    for (const id of refs) {
      if (!registryIds.has(id)) addIssue(issues, "UNREGISTERED_MANUAL_REF", path, `${point.title} references unregistered ${id}.`);
    }
  }
}

function validateProvenanceConsistency({ documents, aggregateResults, evidence, packRoot, issues }) {
  const code = documents.get("code-evidence");
  if (!code || aggregateResults.get("code-evidence")?.state?.status !== "ready") return;

  const codeRoot = sectionFields(code, "Root Repository Provenance");
  const sourceKeys = new Set(sourceRows(code).map(sourceKey));

  for (const [id, artifact] of evidence) {
    if (!id.startsWith("E-CODE-")) continue;
    const fields = sectionFields(artifact, "Repository Provenance");
    for (const field of ["root_repo", "root_commit"]) compareField(codeRoot, fields, field, artifact, packRoot, issues);
    const key = `${scalar(fields.get("source_repo"))}:${scalar(fields.get("source_commit"))}`;
    if (!sourceKeys.has(key)) {
      addIssue(issues, "EVIDENCE_SOURCE_PROVENANCE_MISMATCH", displayPath(artifact.path, packRoot), `${id} source ${key} is not declared in code-evidence.md.`);
    }
  }
}

function validateReadyPack({ evidence, packRoot, packState, issues }) {
  if (packState.status !== "ready") return;
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
    addIssue(issues, "PACK_PROVENANCE_MISMATCH", displayPath(document.path, packRoot), `${field} must match code-evidence.md (${expectedValue}).`);
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
