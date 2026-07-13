#!/usr/bin/env node

const { dirname, resolve } = require("node:path");
const { AGGREGATES } = require("./shared/constants.cjs");
const { addIssue } = require("./shared/diagnostics.cjs");
const { readMarkdown } = require("./shared/markdown.cjs");
const { aggregateValidators } = require("./validators/index.cjs");
const { validateEvidence } = require("./validators/evidence.cjs");
const { validatePack } = require("./validators/pack.cjs");

const MARKER = "SCOUT_RESEARCH_VALIDATE_OK";

function main(argv) {
  if (argv.length === 1 && argv[0] === "--smoke") {
    process.stdout.write(`${MARKER}\n`);
    return;
  }

  const [command, ...args] = argv;
  if (command === "evidence") return validateEvidenceCommand(args);
  if (command === "aggregate") return validateAggregateCommand(args);
  if (command === "pack") return validatePackCommand(args);
  usage();
}

function validateEvidenceCommand(args) {
  if (args.length !== 1) return usage();
  const file = resolve(args[0]);
  const displayRoot = dirname(file);
  const issues = [];
  const document = readMarkdown(file, displayRoot, issues);
  const result = document ? validateEvidence(document, displayRoot, issues) : {};

  if (issues.length > 0) {
    printFailure("evidence", { evidence_file: file }, issues);
    return;
  }
  printSuccess("evidence", {
    evidence_file: file,
    evidence_id: result.evidenceId,
    evidence_kind: result.kind,
    evidence_status: result.status,
  });
}

function validateAggregateCommand(args) {
  if (args.length !== 2) return usage();
  const [kind, target] = args;
  const file = resolve(target);
  const issues = [];
  const validator = aggregateValidators[kind];
  if (!validator) {
    addIssue(
      issues,
      "UNKNOWN_AGGREGATE_KIND",
      file,
      `Unknown aggregate kind: ${kind}. Expected one of: ${Object.keys(AGGREGATES).join(", ")}.`,
    );
  }

  const displayRoot = dirname(file);
  const document = validator ? readMarkdown(file, displayRoot, issues) : undefined;
  const result = document && validator ? validator(document, displayRoot, issues) : {};

  if (issues.length > 0) {
    printFailure("aggregate", { aggregate_kind: kind, aggregate_file: file }, issues);
    return;
  }
  printSuccess("aggregate", {
    aggregate_kind: kind,
    aggregate_file: file,
    aggregate_status: result.state?.status,
    aggregate_completion_state: result.state?.completionState,
  });
}

function validatePackCommand(args) {
  if (args.length !== 1) return usage();
  const packRoot = resolve(args[0]);
  const result = validatePack(packRoot);
  if (result.issues.length > 0) {
    printFailure("research_pack", { pack_root: packRoot }, result.issues);
    return;
  }
  printSuccess("research_pack", {
    pack_root: packRoot,
    aggregate_count: result.aggregateCount,
    evidence_count: result.evidenceCount,
    verification_point_count: result.verificationPointCount,
  });
}

function printFailure(scope, fields, issues) {
  process.stderr.write([
    `${scope}_valid=false`,
    ...outputFields(fields),
    `issue_count=${issues.length}`,
    ...issues.map((issue) => `- [${issue.code}] ${issue.path}: ${issue.message}`),
    "",
  ].join("\n"));
  process.exitCode = 1;
}

function printSuccess(scope, fields) {
  process.stdout.write([
    `${scope}_valid=true`,
    ...outputFields(fields),
    "",
  ].join("\n"));
}

function outputFields(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`);
}

function usage() {
  process.stderr.write([
    "Usage:",
    "  scout-research-validate evidence <evidence-file>",
    "  scout-research-validate aggregate <kind> <aggregate-file>",
    "  scout-research-validate pack <research-pack-dir>",
    "  scout-research-validate --smoke",
    "",
    `Aggregate kinds: ${Object.keys(AGGREGATES).join(", ")}`,
    "",
  ].join("\n"));
  process.exitCode = 1;
}

main(process.argv.slice(2));
