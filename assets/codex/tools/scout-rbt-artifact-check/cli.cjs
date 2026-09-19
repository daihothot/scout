#!/usr/bin/env node
// RBT artifact structure only. Runtime validates commands; agents own claims and conclusions.
const fs = require("node:fs");
const path = require("node:path");

function checkPack(pack, bddId, version) {
  const issues = [];
  const issue = (file, code, message) => issues.push({ file: path.relative(pack, file) || ".", code, message });
  const fixed = ["bdd-evidence.md", "journal-expected.md", "signal-expected.md", "human-input-evidence.md"];
  const templates = path.resolve(__dirname, "../../skills/domain-rbt-execution-pack/templates");
  const placeholders = new Set(fs.readdirSync(templates).filter(f => f.endsWith(".md"))
    .flatMap(f => fs.readFileSync(path.join(templates, f), "utf8").match(/<[^<>\n]+>/g) || []));
  const clean = value => (value || "").trim().replace(/^`(.*)`$/, "$1");
  const missing = value => !value || /^(none|unknown|待确认|待返回)$/i.test(value);
  const refs = value => [...new Set(value?.match(/\b(?:E-BDD|E-CODE|SR|JR)-\d+\b/g) || [])];
  const documents = new Map();
  const idOwners = new Map();
  const declare = (id, prefix, file) => {
    if (!new RegExp(`^${prefix}-\\d+$`).test(id || "")) issue(file, "INVALID_ID", `Expected ${prefix}-<digits>: ${id}`);
    else if (idOwners.has(id)) issue(file, "DUPLICATE_ID", `${id} already declared in ${idOwners.get(id)}`);
    else idOwners.set(id, file);
  };
  const fields = (text, file) => {
    const result = {};
    for (const match of text.matchAll(/^- ([\w]+):[ \t]*(.*)$/gm)) {
      const [, key, raw] = match;
      if (Object.hasOwn(result, key)) issue(file, "DUPLICATE_FIELD", key);
      result[key] = clean(raw);
    }
    return result;
  };
  const requireFields = (data, names, file, complete = true) => {
    for (const name of names) {
      if (!Object.hasOwn(data, name) || !data[name]) issue(file, "MISSING_FIELD", name);
      else if (complete && missing(data[name])) issue(file, "INCOMPLETE_FIELD", name);
    }
  };
  const section = (doc, heading, required = true) => {
    const start = doc.body.indexOf(`## ${heading}\n`);
    if (start < 0) {
      if (required) issue(doc.file, "MISSING_SECTION", heading);
      return "";
    }
    const rest = doc.body.slice(start + heading.length + 4);
    const value = rest.split(/\n## /)[0].trim();
    if (!value) issue(doc.file, "EMPTY_SECTION", heading);
    return value;
  };
  const table = (text, columns, file) => {
    const lines = text.split("\n").filter(line => line.trim().startsWith("|"));
    const cells = line => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(cell => clean(cell.replace(/\\\|/g, "|")));
    if (!lines.length) {
      if (text.trim() !== "none") issue(file, "MISSING_TABLE", columns.join(", "));
      return [];
    }
    const headers = cells(lines[0]);
    if (headers.join() !== columns.join() || !lines[1] || !cells(lines[1]).every(c => /^:?-+:?$/.test(c))) {
      issue(file, "TABLE_COLUMNS", `Expected ${columns.join(" | ")}`);
      return [];
    }
    return lines.slice(2).map(line => {
      const values = cells(line);
      if (values.length !== columns.length || values.some(v => !v)) issue(file, "TABLE_ROW", line);
      return Object.fromEntries(columns.map((key, i) => [key, values[i] || ""]));
    });
  };
  const load = file => {
    let text;
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error("Expected a regular file, not a symlink or directory");
      text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    } catch (error) { issue(file, "READ_ERROR", error.message); return null; }
    const front = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
    if (!front) { issue(file, "FRONTMATTER", "Missing frontmatter"); return null; }
    const meta = {};
    for (const match of front[1].matchAll(/^([\w]+):[ \t]*(.*)$/gm)) {
      if (Object.hasOwn(meta, match[1])) issue(file, "DUPLICATE_FIELD", match[1]);
      meta[match[1]] = clean(match[2]).replace(/^['"](.*)['"]$/, "$1");
    }
    for (const key of ["status", "completion_state"]) {
      if (Object.hasOwn(meta, key)) issue(file, "ARTIFACT_STATE", `${key} is not allowed`);
    }
    const body = text.slice(front[0].length).trim() + "\n";
    if (/^## (?:Artifact|Evidence) State$/m.test(body)) issue(file, "ARTIFACT_STATE", "Artifact lifecycle sections are not allowed");
    for (const placeholder of placeholders) {
      // Boundary prose may mention <human-response>; it is a protocol tag, not a placeholder.
      if (placeholder !== "<human-response>" && body.includes(placeholder)) issue(file, "PLACEHOLDER", placeholder);
    }
    const headings = [...body.matchAll(/^## (.+)$/gm)].map(m => m[1]);
    if (new Set(headings).size !== headings.length) issue(file, "DUPLICATE_SECTION", "Repeated level-2 heading");
    const doc = { file, meta, body };
    documents.set(path.basename(file), doc);
    return doc;
  };
  const artifact = (doc, type, artifactVersion) => {
    if (doc.meta.artifact_type !== type || doc.meta.artifact_version !== String(artifactVersion)) issue(doc.file, "ARTIFACT_VERSION", `${type} requires artifact_version ${artifactVersion}`);
  };

  if (path.basename(pack) !== "execute-pack" || path.basename(path.dirname(pack)) !== version || path.basename(path.dirname(path.dirname(pack))) !== bddId) issue(pack, "PACK_IDENTITY", "Expected <bdd-id>/<target-version>/execute-pack");
  try {
    if (!fs.lstatSync(pack).isDirectory() || fs.lstatSync(pack).isSymbolicLink()) throw new Error("Expected a regular pack directory");
    for (const name of fs.readdirSync(path.dirname(pack))) if (!["execute-file.json", "execute-pack"].includes(name)) issue(path.join(pack, "..", name), "EXTRA_ARTIFACT", "Only template-defined artifacts are allowed");
    for (const name of fs.readdirSync(pack)) if (![...fixed, "evidence"].includes(name)) issue(path.join(pack, name), "EXTRA_ARTIFACT", "Only template-defined artifacts are allowed");
  } catch (error) { issue(pack, "READ_ERROR", error.message); return issues; }
  for (const file of fixed) load(path.join(pack, file));
  const codeDir = path.join(pack, "evidence");
  if (fs.existsSync(codeDir)) {
    if (!fs.lstatSync(codeDir).isDirectory() || fs.lstatSync(codeDir).isSymbolicLink()) issue(codeDir, "READ_ERROR", "Expected regular evidence directory");
    else for (const name of fs.readdirSync(codeDir)) {
      if (!/^E-CODE-\d+\.md$/.test(name)) { issue(path.join(codeDir, name), "EXTRA_ARTIFACT", "Expected E-CODE-<digits>.md"); continue; }
      const doc = load(path.join(codeDir, name));
      if (!doc) continue;
      declare(doc.meta.evidence_id, "E-CODE", doc.file);
      if (doc.meta.evidence_id !== path.basename(name, ".md") || doc.meta.evidence_type !== "source_code") issue(doc.file, "EVIDENCE_IDENTITY", "Filename, evidence_id and evidence_type must agree");
      const code = fields(section(doc, "Codebase"), doc.file);
      const locator = fields(section(doc, "Source Locator"), doc.file);
      const symbol = fields(section(doc, "Primary Symbol"), doc.file);
      requireFields(code, ["codebase", "version", "codegraph_status"], doc.file);
      requireFields(locator, ["source_relative_file", "canonical_locator"], doc.file);
      requireFields(symbol, ["name", "type", "start_line", "end_line", "signature"], doc.file);
      if (!missing(code.version) && code.version !== version) issue(doc.file, "VERSION_MISMATCH", code.version);
      if (!missing(locator.canonical_locator) && locator.canonical_locator !== `${code.version}:${locator.source_relative_file}`) issue(doc.file, "SOURCE_LOCATOR", "Expected version:source_relative_file");
      if (path.isAbsolute(locator.source_relative_file || "") || (locator.source_relative_file || "").split(/[\\/]/).includes("..")) issue(doc.file, "SOURCE_LOCATOR", "Source path must stay relative to codebase");
      if ((!missing(symbol.start_line) || !missing(symbol.end_line)) && (!/^[1-9]\d*$/.test(symbol.start_line) || !/^[1-9]\d*$/.test(symbol.end_line) || Number(symbol.start_line) > Number(symbol.end_line))) issue(doc.file, "SOURCE_LINES", "Expected positive ordered symbol line numbers");
      for (const heading of ["Claim", "Collection", "Limitations"]) section(doc, heading);
      table(section(doc, "Key Lines"), ["行号", "原因"], doc.file);
      if (/\b(?:JR|SR|HI)-\d+\b/.test(doc.body)) issue(doc.file, "REVERSE_REF", "Source evidence must not reference consumers");
    }
  }
  const bdd = documents.get("bdd-evidence.md");
  if (bdd) {
    artifact(bdd, "RBTBDDEvidence", 1);
    declare(bdd.meta.evidence_id, "E-BDD", bdd.file);
    if (bdd.meta.evidence_id !== "E-BDD-001") issue(bdd.file, "EVIDENCE_IDENTITY", "Expected E-BDD-001");
    const identity = fields(section(bdd, "BDD Identity"), bdd.file);
    requireFields(identity, ["bdd_id", "scenario_id", "case_id", "source_ref", "source_locator", "source_status"], bdd.file);
    if (!missing(identity.bdd_id) && identity.bdd_id !== bddId) issue(bdd.file, "BDD_MISMATCH", identity.bdd_id);
    for (const heading of ["Claim", "Given", "When", "Then", "Boundaries"]) section(bdd, heading);
    if (/\b(?:JR|SR|HI|E-CODE)-\d+\b/.test(bdd.body)) issue(bdd.file, "REVERSE_REF", "BDD evidence must not reference consumers");
  }
  const journal = documents.get("journal-expected.md");
  const scope = journal ? fields(section(journal, "Query Scope"), journal.file) : {};
  if (journal) { artifact(journal, "RBTJournalExpected", 4); requireFields(scope, ["campaignId", "scenarioId"], journal.file); }
  const signals = new Map();
  const journaledSignals = new Set();
  const signal = documents.get("signal-expected.md");
  if (signal) {
    artifact(signal, "RBTSignalExpected", 4);
    if (signal.meta.bdd_ref !== bdd?.meta.evidence_id) issue(signal.file, "DANGLING_REF", "bdd_ref");
    for (const [, heading] of signal.body.matchAll(/^## (SR-.*)$/gm)) if (!/^SR-\d+$/.test(heading)) issue(signal.file, "INVALID_ID", heading);
    for (const match of signal.body.matchAll(/^## (SR-\d+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)) {
      const [, id, body] = match;
      declare(id, "SR", signal.file);
      const data = fields(body.split(/^### Fields$/m)[0], signal.file);
      requireFields(data, ["signal_ref", "claim", "bdd_refs", "expected_presence", "observation_scope", "code_refs", "limitations"], signal.file, false);
      requireFields(data, ["claim", "observation_scope"], signal.file);
      if (data.signal_ref !== "signal-rbt-evidence" || !["present", "absent"].includes(data.expected_presence)) issue(signal.file, "SIGNAL_CONTRACT", id);
      for (const [key, prefix] of [["bdd_refs", "E-BDD"], ["code_refs", "E-CODE"]]) {
        const ids = refs(data[key]);
        if (!ids.length) issue(signal.file, "MISSING_REF", `${id}.${key}`);
        for (const ref of ids) if (!ref.startsWith(prefix + "-") || !idOwners.has(ref)) issue(signal.file, "DANGLING_REF", `${id}: ${ref}`);
      }
      for (const locator of data.bdd_refs?.match(/\b[GWT]-\d+\b/g) || []) if (!bdd?.body.includes(locator)) issue(signal.file, "BDD_LOCATOR", `${id}: ${locator}`);
      const rows = table(body.split(/^### Fields\s*$/m)[1] || "", ["field", "role", "expected_value", "comparison"], signal.file);
      const byField = new Map();
      for (const row of rows) {
        if (byField.has(row.field)) issue(signal.file, "DUPLICATE_FIELD", `${id}.${row.field}`);
        byField.set(row.field, row);
        if (!["locate", "assert"].includes(row.role)) issue(signal.file, "FIELD_ROLE", `${id}.${row.field}`);
      }
      for (const name of ["campaignId", "scenarioId"]) if (byField.get(name)?.role !== "locate" || clean(byField.get(name)?.expected_value) !== scope[name]) issue(signal.file, "QUERY_SCOPE", `${id}.${name} must match Journal scope`);
      if (/\b(?:JR|HI)-\d+\b/.test(body)) issue(signal.file, "REVERSE_REF", `${id} must not reference consumers`);
      signals.set(id, { ...data, fields: byField });
    }
    if (!signals.size) issue(signal.file, "MISSING_SIGNAL", "Pack requires SR declarations");
  }
  if (journal) {
    let previous = 0;
    for (const row of table(section(journal, "Expected Journal Records"), ["order", "jr_id", "kind", "id", "variantId", "sourceId", "captureId", "signal_refs"], journal.file)) {
      declare(row.jr_id, "JR", journal.file);
      if (row.order !== "none") {
        if (!/^[1-9]\d*$/.test(row.order) || Number(row.order) <= previous) issue(journal.file, "JOURNAL_ORDER", row.jr_id);
        previous = Number(row.order);
      }
      const targets = refs(row.signal_refs);
      if (!targets.length) issue(journal.file, "MISSING_REF", row.jr_id);
      for (const ref of targets) {
        journaledSignals.add(ref);
        const sr = signals.get(ref);
        if (!sr) { issue(journal.file, "DANGLING_REF", ref); continue; }
        if (sr.expected_presence !== "present") issue(journal.file, "ABSENT_JOURNAL", ref);
        for (const key of ["kind", "id", "variantId", "sourceId", "captureId"]) if (row[key] !== "none" && row[key] !== sr.fields.get(key)?.expected_value) issue(journal.file, "JOURNAL_IDENTITY", `${row.jr_id}.${key} disagrees with ${ref}`);
      }
    }
  }
  const human = documents.get("human-input-evidence.md");
  if (human) {
    artifact(human, "RBTHumanInputEvidence", 1);
    const records = section(human, "Human Input Records");
    for (const [, heading] of records.matchAll(/^### (HI-.*)$/gm)) if (!/^HI-\d+$/.test(heading)) issue(human.file, "INVALID_ID", heading);
    const blocks = [...records.matchAll(/^### (HI-\d+)\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)];
    if (!blocks.length && records !== "none") issue(human.file, "HUMAN_RECORDS", "Expected none or HI records");
    for (const [, id, body] of blocks) {
      declare(id, "HI", human.file);
      const data = fields(body, human.file);
      requireFields(data, ["request_id", "task_id", "reason", "question", "status", "response_ref", "response_summary", "effect_on_plan", "related_refs"], human.file, false);
      requireFields(data, ["request_id", "task_id"], human.file, true);
      if (!["pending", "resolved", "cancelled"].includes(data.status)) issue(human.file, "HUMAN_STATE", id);
      if (data.status === "resolved" && missing(data.response_ref)) issue(human.file, "HUMAN_RESPONSE", id);
      if (data.status === "pending") issue(human.file, "PENDING_HUMAN_INPUT", id);
      for (const ref of refs(data.related_refs)) if (!idOwners.has(ref)) issue(human.file, "DANGLING_REF", ref);
    }
  }

  const execute = path.join(pack, "..", "execute-file.json");
  try {
    if (!fs.lstatSync(execute).isFile()) throw new Error("Expected regular execute-file.json");
    const plan = JSON.parse(fs.readFileSync(execute, "utf8"));
    const commands = ["behavior.campaign.start", "behavior.scenario.activate", "behavior.trigger.invoke", "behavior.scenario.deactivate", "behavior.campaign.stop"];
    if (!plan || Object.keys(plan).join() !== "commands" || !Array.isArray(plan.commands) || plan.commands.length !== 5) throw new Error("Expected only commands, containing the five lifecycle commands");
    plan.commands.forEach((entry, i) => {
      if (entry?.command !== commands[i] || Object.keys(entry).sort().join() !== "command,payload" || !entry.payload || typeof entry.payload !== "object" || Array.isArray(entry.payload)) throw new Error(`Invalid command at index ${i}`);
      for (const key of i === 0 ? ["campaignId", "scenarioId"] : i === 4 ? ["campaignId"] : ["scenarioId"]) if (entry.payload[key] !== scope[key]) issue(execute, "EXECUTE_SCOPE", `${i}.${key} disagrees with Journal scope`);
    });
    const activate = plan.commands[1].payload;
    for (const activation of activate.activations || []) {
      const covered = [...signals.values()].some(sr =>
        sr.expected_presence === "present"
        && sr.fields.get("kind")?.expected_value === "behavior_trace"
        && sr.fields.get("id")?.expected_value === activation.id
        && sr.fields.get("variantId")?.expected_value === activation.variantId
        && sr.fields.get("result")?.role === "assert"
      );
      if (!covered) issue(execute, "UNCOVERED_ACTIVATION", `${activation.id}/${activation.variantId}`);
    }
    for (const capture of activate.evidenceCapture?.captures || []) {
      const covered = [...signals.values()].some(sr =>
        sr.expected_presence === "present"
        && sr.fields.get("kind")?.expected_value === "capture_result"
        && sr.fields.get("id")?.expected_value === capture.nodeId
        && sr.fields.get("sourceId")?.expected_value === capture.sourceId
        && sr.fields.get("captureId")?.expected_value === capture.captureId
      );
      if (!covered) issue(execute, "UNCOVERED_CAPTURE", `${capture.nodeId}/${capture.sourceId}/${capture.captureId}`);
    }
    const triggerCommandId = plan.commands[2].payload.triggerCommandId;
    const triggerCovered = [...signals.values()].some(sr =>
      sr.expected_presence === "present"
      && sr.fields.get("kind")?.expected_value === "response_payload"
      && sr.fields.get("sourceId")?.expected_value === triggerCommandId
    );
    if (!triggerCovered) issue(execute, "UNCOVERED_TRIGGER", String(triggerCommandId));
  } catch (error) { issue(execute, "EXECUTE_FILE", error.message); }
  for (const [id, sr] of signals) {
    if (sr.expected_presence === "present" && !journaledSignals.has(id)) {
      issue(signal?.file ?? pack, "UNJOURNALED_PRESENT_SIGNAL", id);
    }
  }
  return issues;
}

function main(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log([
      "Usage:",
      "  scout-rbt-artifact-check pack <execute-pack-dir> --bdd-id <id> --target-version <version>",
      "  scout-rbt-artifact-check --help|-h",
      "  scout-rbt-artifact-check --smoke",
    ].join("\n"));
    return;
  }
  if (args.length === 1 && args[0] === "--smoke") return console.log("SCOUT_RBT_ARTIFACT_CHECK_OK");
  const [command, directory, bddFlag, bddId, versionFlag, version] = args;
  if (args.length !== 6 || command !== "pack" || bddFlag !== "--bdd-id" || versionFlag !== "--target-version") {
    console.error("Usage: scout-rbt-artifact-check pack <execute-pack-dir> --bdd-id <id> --target-version <version>");
    process.exitCode = 2;
    return;
  }
  const issues = checkPack(path.resolve(directory), bddId, version);
  console.log(`rbt_pack_valid=${issues.length === 0}`);
  for (const issue of issues) console.error(`[${issue.code}] ${issue.file}: ${issue.message}`);
  process.exitCode = issues.length ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { checkPack };
