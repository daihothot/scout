const { AGGREGATES, STATE_PAIRS } = require("../shared/constants.cjs");
const { addIssue } = require("../shared/diagnostics.cjs");
const { bulletFields, displayPath, hasTemplateInstruction, isNone, normalized, sectionByTitle } = require("../shared/markdown.cjs");
const { researchTemplatePath, validateTemplateSections } = require("../shared/templates.cjs");

function validateAggregateBase(document, kind, displayRoot, issues) {
  const config = AGGREGATES[kind];
  if (!config) throw new Error(`Unknown aggregate validator: ${kind}`);
  validateTemplateSections(document, researchTemplatePath(config.template), displayRoot, issues);
  return validateAggregateState(document, config.stateHeading, displayRoot, issues);
}

function validateAggregateState(document, stateHeading, displayRoot, issues) {
  const section = sectionByTitle(document, 2, stateHeading);
  if (!section) return undefined;
  const fields = bulletFields(section.text);
  const status = normalized(fields.get("status"));
  const completionState = normalized(fields.get("completion_state"));
  const pair = `${status}:${completionState}`;
  const path = displayPath(document.path, displayRoot);

  if (!STATE_PAIRS.has(pair)) {
    addIssue(issues, "INVALID_STATE_PAIR", path, `Illegal status pair: ${status || "<empty>"} + ${completionState || "<empty>"}.`);
  }
  if (normalized(document.frontMatter.status) !== status) {
    addIssue(issues, "STATUS_MISMATCH", path, "Frontmatter status must match the artifact state section.");
  }
  if (normalized(document.frontMatter.completion_state) !== completionState) {
    addIssue(issues, "COMPLETION_STATE_MISMATCH", path, "Frontmatter completion_state must match the artifact state section.");
  }

  const blockers = fields.get("blocking_items");
  if (status === "ready" && !isNone(blockers)) {
    addIssue(issues, "READY_WITH_BLOCKER", path, "ready + complete requires blocking_items to be none.");
  }
  if (status === "blocked" && isNone(blockers)) {
    addIssue(issues, "BLOCKED_WITHOUT_BLOCKER", path, "blocked + blocked requires a concrete blocking_items value.");
  }
  if (status === "ready" && hasTemplateInstruction(document.text)) {
    addIssue(issues, "TEMPLATE_INSTRUCTION_REMAINS", path, "ready + complete artifacts cannot retain template fill instructions.");
  }
  return { status, completionState, fields };
}

module.exports = { validateAggregateBase };
