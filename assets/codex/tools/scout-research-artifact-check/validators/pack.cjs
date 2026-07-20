const { existsSync, readdirSync, statSync } = require("node:fs");
const { basename, join, resolve } = require("node:path");
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
    return result(issues, 0, 0, 0, { status: "blocked", completionState: "blocked" });
  }

  if (/-v\d+$/i.test(basename(resolve(packRoot)))) {
    addIssue(
      issues,
      "VERSIONED_PACK_DIRECTORY_FORBIDDEN",
      packRoot,
      "Research pack directory must not use a -vN revision suffix.",
    );
  }
  const allowedEntries = new Set([
    ...Object.values(AGGREGATES).map(({ file }) => file),
    "evidence",
  ]);
  for (const entry of readdirSync(packRoot, { withFileTypes: true })) {
    if (allowedEntries.has(entry.name)) continue;
    addIssue(
      issues,
      "UNDECLARED_PACK_ENTRY",
      entry.name,
      "Research pack root may contain only declared aggregate files and the evidence directory.",
    );
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
  const aggregateStates = Object.keys(AGGREGATES).map((kind) => aggregateResults.get(kind)?.state);
  const packState = aggregateStates.some((state) => state?.status === "blocked")
    ? { status: "blocked", completionState: "blocked" }
    : aggregateStates.every((state) => state?.status === "ready" && state.completionState === "complete")
      ? { status: "ready", completionState: "complete" }
      : { status: "draft", completionState: "partial" };

  validatePackRelations({
    aggregateResults,
    documents,
    evidence,
    issues,
    packRoot,
    packState,
    registryIds,
  });

  const verificationPointCount = aggregateResults.get("verification-manual")?.verificationPointCount ?? 0;
  return result(issues, documents.size, evidence.size, verificationPointCount, packState);
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

function result(issues, aggregateCount, evidenceCount, verificationPointCount, packState) {
  return { issues, aggregateCount, evidenceCount, packState, verificationPointCount };
}

module.exports = { validatePack };
