#!/usr/bin/env node

const { accessSync, constants, existsSync, readdirSync, statSync } = require("node:fs");
const { basename, dirname, join, resolve } = require("node:path");

const MARKER = "SCOUT_MEMORY_OK";
const MEMORY_FILE_PATTERN = /^(memories|logs|goals|state)_\d+\.sqlite(?:-(?:wal|shm))?$/;

function main(argv) {
  const [command = "list"] = argv;
  if (command === "--smoke") {
    const view = buildMemoryView();
    if (!view.exists || !view.readable) {
      fail(`Run memory is not readable at ${view.codexHome}`);
    }
    process.stdout.write(`${MARKER} codexHome=${view.codexHome} files=${view.files.length}\n`);
    return;
  }
  if (command === "list") return printJson(buildMemoryView());
  usage(1);
}

function buildMemoryView() {
  const runRoot = discoverRunRoot();
  const codexHome = join(runRoot, "codex-home", ".codex");
  const exists = existsSync(codexHome);
  const readable = exists && canRead(codexHome);
  return {
    runRoot,
    codexHome,
    exists,
    readable,
    files: readable ? listMemoryFiles(codexHome) : [],
  };
}

function discoverRunRoot() {
  if (process.env.SCOUT_RUN_ROOT) return resolve(process.env.SCOUT_RUN_ROOT);

  let current = resolve(process.cwd());
  while (true) {
    if (existsSync(join(current, "codex-home", ".codex"))) return current;
    if (basename(current) === "mount" && basename(dirname(dirname(current))) === "agents") {
      return dirname(dirname(dirname(current)));
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  fail(`Unable to infer run root from cwd: ${process.cwd()}`);
}

function listMemoryFiles(codexHome) {
  return readdirSync(codexHome)
    .filter((name) => MEMORY_FILE_PATTERN.test(name))
    .sort()
    .map((name) => fileSummary(codexHome, name));
}

function fileSummary(codexHome, name) {
  const path = join(codexHome, name);
  const stats = statSync(path);
  return {
    name,
    kind: name.split("_")[0],
    path,
    readable: canRead(path),
    sizeBytes: stats.size,
    mtime: stats.mtime.toISOString(),
  };
}

function canRead(path) {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(code) {
  const out = code === 0 ? process.stdout : process.stderr;
  out.write([
    "Usage:",
    "  scout-memory list",
    "  scout-memory --smoke",
    "",
  ].join("\n"));
  process.exit(code);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main(process.argv.slice(2));
