#!/usr/bin/env node

const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, readdirSync } = require("node:fs");
const { basename, join, relative, resolve, sep } = require("node:path");

const MARKER = "SCOUT_ARTIFACT_DIGEST_OK";
const DIRECTORY_ALGORITHM = "scout-directory-sha256-v1";

function main(argv) {
  if (argv.length === 1 && argv[0] === "--smoke") {
    process.stdout.write(`${MARKER}\n`);
    return;
  }
  if (argv.length !== 1) return usage();

  const target = resolve(argv[0]);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      throw new Error("Symbolic links are not accepted as digest targets.");
    }
    if (stat.isFile()) {
      printDigest({
        target,
        kind: "file",
        algorithm: "sha256",
        fileCount: 1,
        digest: createHash("sha256").update(readFileSync(target)).digest("hex"),
      });
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error("Digest target must be a regular file or directory.");
    }

    const files = collectFiles(target);
    const hash = createHash("sha256");
    for (const file of files) {
      const relativePath = relative(target, file).split(sep).join("/");
      const content = readFileSync(file);
      hash.update("file\0");
      hash.update(relativePath);
      hash.update("\0");
      hash.update(String(content.byteLength));
      hash.update("\0");
      hash.update(content);
      hash.update("\0");
    }
    printDigest({
      target,
      kind: "directory",
      algorithm: DIRECTORY_ALGORITHM,
      fileCount: files.length,
      digest: hash.digest("hex"),
    });
  } catch (error) {
    process.stderr.write([
      "artifact_digest_valid=false",
      `artifact_ref=${target}`,
      `error=${error instanceof Error ? error.message : String(error)}`,
      "",
    ].join("\n"));
    process.exitCode = 1;
  }
}

function collectFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are not accepted inside directory targets: ${relative(root, path)}`);
      }
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      } else {
        throw new Error(`Unsupported directory entry: ${relative(root, path)}`);
      }
    }
  };
  visit(root);
  return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

function printDigest(input) {
  process.stdout.write([
    "artifact_digest_valid=true",
    `artifact_ref=${input.target}`,
    `artifact_name=${basename(input.target)}`,
    `artifact_kind=${input.kind}`,
    `digest_algorithm=${input.algorithm}`,
    `file_count=${input.fileCount}`,
    `digest=sha256:${input.digest}`,
    "",
  ].join("\n"));
}

function usage() {
  process.stderr.write([
    "Usage:",
    "  scout-artifact-digest <file-or-directory>",
    "  scout-artifact-digest --smoke",
    "",
  ].join("\n"));
  process.exitCode = 1;
}

main(process.argv.slice(2));
