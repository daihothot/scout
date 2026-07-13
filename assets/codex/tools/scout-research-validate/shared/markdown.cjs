const { existsSync, readFileSync, statSync } = require("node:fs");
const { relative, sep } = require("node:path");
const { EVIDENCE_ID_GLOBAL } = require("./constants.cjs");
const { addIssue } = require("./diagnostics.cjs");

function readMarkdown(path, displayRoot, issues) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    addIssue(issues, "REQUIRED_ARTIFACT_MISSING", displayPath(path, displayRoot), "Required Markdown artifact is missing.");
    return undefined;
  }
  try {
    return parseMarkdown(path, readFileSync(path, "utf8"));
  } catch (error) {
    addIssue(issues, "ARTIFACT_READ_FAILED", displayPath(path, displayRoot), error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function parseMarkdown(path, text) {
  const lines = text.split(/\r?\n/);
  const frontMatter = {};
  let bodyStart = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const match = line.match(/^([A-Za-z0-9_]+):\s*(.*?)\s*$/);
        if (match) frontMatter[match[1]] = stripQuotes(match[2]);
      }
      bodyStart = end + 1;
    }
  }

  const bodyLines = lines.slice(bodyStart);
  const headings = [];
  for (let index = 0; index < bodyLines.length; index += 1) {
    const match = bodyLines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (match) headings.push({ level: match[1].length, title: match[2], lineIndex: index });
  }
  return { path, text, bodyLines, frontMatter, headings };
}

function sectionByTitle(document, level, title) {
  const heading = document.headings.find((item) => item.level === level && item.title === title);
  return heading ? sectionAt(document, heading) : undefined;
}

function sectionAt(document, heading) {
  const endHeading = document.headings.find((item) => item.lineIndex > heading.lineIndex && item.level <= heading.level);
  const end = endHeading ? endHeading.lineIndex : document.bodyLines.length;
  const bodyLines = document.bodyLines.slice(heading.lineIndex + 1, end);
  const headings = document.headings
    .filter((item) => item.lineIndex > heading.lineIndex && item.lineIndex < end)
    .map((item) => ({ ...item, lineIndex: item.lineIndex - heading.lineIndex - 1 }));
  return {
    path: document.path,
    text: bodyLines.join("\n"),
    bodyLines,
    frontMatter: document.frontMatter,
    headings,
  };
}

function bulletFields(text) {
  const fields = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+([A-Za-z0-9_]+):\s*(.*?)\s*$/);
    if (match && !fields.has(match[1])) fields.set(match[1], stripQuotes(match[2]));
  }
  return fields;
}

function markdownTable(text) {
  const lines = text.split(/\r?\n/).filter((line) => /^\s*\|.*\|\s*$/.test(line));
  if (lines.length < 2) return [];
  const cells = (line) => line.trim().slice(1, -1).split("|").map((value) => value.trim());
  const headers = cells(lines[0]);
  const start = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(lines[1]) ? 2 : 1;
  return lines.slice(start).map((line) => {
    const values = cells(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  }).filter((row) => Object.values(row).some((value) => !isPlaceholder(value)));
}

function evidenceIds(text) {
  return new Set(text.match(EVIDENCE_ID_GLOBAL) || []);
}

function hasConcreteContent(text) {
  return text.split(/\r?\n/).some((line) => {
    const value = line.replace(/^\s*-\s*/, "").trim();
    if (!value || value === "-") return false;
    const field = value.match(/^[A-Za-z0-9_]+:\s*(.*)$/);
    return field ? !isPlaceholder(field[1]) : !isPlaceholder(value);
  });
}

function normalized(value) {
  return scalar(value).toLowerCase();
}

function scalar(value) {
  return typeof value === "string" ? stripQuotes(value).trim() : "";
}

function stripQuotes(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isPlaceholder(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length === 0 || text === "-" || /^<.*>$/.test(text);
}

function isNone(value) {
  return ["none", "无", "n/a", "[]", "irrelevant"].includes(normalized(value));
}

function displayPath(path, root) {
  const value = relative(root, path);
  if (!value || value === "") return ".";
  if (value === ".." || value.startsWith(`..${sep}`)) return path;
  return value;
}

module.exports = {
  bulletFields,
  displayPath,
  evidenceIds,
  hasConcreteContent,
  isNone,
  isPlaceholder,
  markdownTable,
  normalized,
  parseMarkdown,
  readMarkdown,
  scalar,
  sectionAt,
  sectionByTitle,
};
