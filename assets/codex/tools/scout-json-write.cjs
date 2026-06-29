#!/usr/bin/env node

const { mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { dirname, resolve, sep } = require("node:path");

function main(argv) {
  const [command, ...args] = argv;
  if (command === "--smoke") {
    process.stdout.write("SCOUT_JSON_WRITE_OK\n");
    return;
  }
  if (command === "artifact") {
    writeJson(command, args);
    return;
  }
  usage(1);
}

function writeJson(scope, args) {
  const [relativePath, jsonFile] = args;
  if (!relativePath || !jsonFile) usage(1);
  const root = readRoot(scope);
  const targetPath = resolveTarget(root, relativePath);
  const jsonText = jsonFile === "-"
    ? readFileSync(0, "utf8")
    : readFileSync(resolve(jsonFile), "utf8");
  const value = parseJson(jsonText, jsonFile);
  writeJsonFile(targetPath, value);
  process.stdout.write([
    "json_written=true",
    `scope=${scope}`,
    `path=${targetPath}`,
    "",
  ].join("\n"));
}

function readRoot(scope) {
  const key = "SCOUT_ARTIFACT_ROOT";
  const value = process.env[key] && process.env[key].trim();
  if (!value) fail(`${key} is required.`);
  return resolve(value);
}

function resolveTarget(root, relativePath) {
  if (relativePath.startsWith("/") || relativePath.includes("\0")) {
    fail("Target path must be relative.");
  }
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    fail(`Target path escapes root: ${relativePath}`);
  }
  if (!target.endsWith(".json")) {
    fail("Target path must end with .json.");
  }
  return target;
}

function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`Invalid JSON in ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

function usage(code) {
  const out = code === 0 ? process.stdout : process.stderr;
  out.write([
    "Usage:",
    "  scout-json-write artifact <relative-output.json> <source.json|->",
    "  scout-json-write --smoke",
    "",
  ].join("\n"));
  process.exit(code);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main(process.argv.slice(2));
