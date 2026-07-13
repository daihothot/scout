const { addIssue } = require("../shared/diagnostics.cjs");
const { bulletFields, displayPath, evidenceIds, hasConcreteContent, isNone, normalized, scalar, sectionAt, sectionByTitle } = require("../shared/markdown.cjs");
const { validateAggregateBase } = require("./aggregate-state.cjs");

function validateVerificationManual(document, displayRoot, issues) {
  const state = validateAggregateBase(document, "verification-manual", displayRoot, issues);
  const path = displayPath(document.path, displayRoot);
  const points = document.headings.filter((heading) => heading.level === 3 && /^VP-\d+\b/.test(heading.title));
  if (points.length === 0) {
    addIssue(issues, "VERIFICATION_POINT_MISSING", path, "At least one verification point is required.");
  }

  for (const point of points) {
    const pointSection = sectionAt(document, point);
    const fields = bulletFields(pointSection.text);
    const bddRef = scalar(fields.get("bdd_evidence_ref"));
    if (!/^E-BDD-\d+$/.test(bddRef)) {
      addIssue(issues, "INVALID_BDD_EVIDENCE_REF", path, `${point.title} requires a valid bdd_evidence_ref.`);
    }
    for (const title of ["Given", "When", "Then", "Supporting Evidence", "Signals To Collect", "需人工确认项", "Notes"]) {
      const child = sectionByTitle(pointSection, 4, title);
      if (!child) addIssue(issues, "MANUAL_SECTION_MISSING", path, `${point.title} is missing ${title}.`);
      if (state && state.status === "ready" && ["Given", "When", "Then", "Signals To Collect"].includes(title) && (!child || !hasConcreteContent(child.text))) {
        addIssue(issues, "MANUAL_SECTION_EMPTY", path, `${point.title} ${title} must contain concrete content for ready + complete.`);
      }
    }
    const supporting = sectionByTitle(pointSection, 4, "Supporting Evidence");
    const refs = supporting ? evidenceIds(supporting.text) : new Set();
    if (bddRef && !refs.has(bddRef)) {
      addIssue(issues, "BDD_REF_NOT_SUPPORTING", path, `${point.title} bdd_evidence_ref must appear in Supporting Evidence.`);
    }
    if (state && state.status === "ready" && ![...refs].some((id) => id.startsWith("E-CODE-"))) {
      addIssue(issues, "MANUAL_CODE_EVIDENCE_MISSING", path, `${point.title} requires E-CODE evidence for ready + complete.`);
    }
  }

  if (state && state.status === "ready") {
    const persona = sectionByTitle(document, 2, "User Persona To Confirm");
    const fields = persona ? bulletFields(persona.text) : new Map();
    for (const field of ["persona_id", "account_state", "subscription_state", "value_segment", "demographic_flags", "locale_or_region", "platform", "app_version"]) {
      const value = normalized(fields.get(field));
      if (!value || value === "unknown") {
        addIssue(issues, "PERSONA_NOT_CONFIRMED", path, `${field} must be confirmed or irrelevant for ready + complete.`);
      }
    }
    if (!isNone(fields.get("confirmation_needed"))) {
      addIssue(issues, "PERSONA_CONFIRMATION_OPEN", path, "ready + complete requires confirmation_needed: none.");
    }
  }
  return { state, verificationPointCount: points.length };
}

module.exports = { validateVerificationManual };
