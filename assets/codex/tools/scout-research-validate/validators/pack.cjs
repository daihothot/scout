const { existsSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { AGGREGATES } = require("../shared/constants.cjs");
const { addIssue } = require("../shared/diagnostics.cjs");
const { readMarkdown, scalar } = require("../shared/markdown.cjs");
const { validateEvidence } = require("./evidence.cjs");
const { aggregateValidators } = require("./index.cjs");
const { validatePackRelations } = require("./pack-relations.cjs");

function validatePack(packRoot) {
  const issues = [];
  const documents = new Map();
  const aggregateResults = new Map();

  if (!existsSync(packRoot) || !statSync(packRoot).isDirectory()) {
    addIssue(issues, "PACK_NOT_FOUND", packRoot, "Research pack directory does not exist.");
    return result(issues, 0, 0, 0);
  }

  for (const [kind, config] of Object.entries(AGGREGATES)) {
    const document = readMarkdown(join(packRoot, config.file), packRoot, issues);
    if (!document) continue;
    documents.set(kind, document);
    aggregateResults.set(kind, aggregateValidators[kind](document, packRoot, issues));
  }

  const evidence = readEvidenceArtifacts(packRoot, issues);
  for (const document of evidence.values()) validateEvidence(document, packRoot, issues);
  const registryIds = aggregateResults.get("evidence-registry")?.registryIds ?? new Set();

  validatePackRelations({
    aggregateResults,
    documents,
    evidence,
    issues,
    packRoot,
    registryIds,
  });

  const verificationPointCount = aggregateResults.get("verification-manual")?.verificationPointCount ?? 0;
  return result(issues, documents.size, evidence.size, verificationPointCount);
}

function readEvidenceArtifacts(packRoot, issues) {
  const evidenceRoot = join(packRoot, "evidence");
  const artifacts = new Map();
  if (!existsSync(evidenceRoot) || !statSync(evidenceRoot).isDirectory()) {
    addIssue(issues, "EVIDENCE_DIRECTORY_MISSING", "evidence", "Evidence directory is required.");
    return artifacts;
  }
  for (const entry of readdirSync(evidenceRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const document = readMarkdown(join(evidenceRoot, entry.name), packRoot, issues);
    if (!document) continue;
    const id = scalar(document.frontMatter.evidence_id);
    if (artifacts.has(id)) addIssue(issues, "DUPLICATE_EVIDENCE_ID", `evidence/${entry.name}`, `Duplicate evidence id: ${id}.`);
    artifacts.set(id, document);
  }
  return artifacts;
}

function result(issues, aggregateCount, evidenceCount, verificationPointCount) {
  return { issues, aggregateCount, evidenceCount, verificationPointCount };
}

module.exports = { validatePack };
