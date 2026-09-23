#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { join, resolve } = require("node:path");

const codegraphRoot = resolve(__dirname);
const codegraphShim = join(
  codegraphRoot,
  "vendor",
  "codegraph",
  "node_modules",
  "@colbymchenry",
  "codegraph",
  "npm-shim.js",
);

const targetPath = process.env.SCOUT_MCP_TARGET_PATH;
const args = [codegraphShim, "serve", "--mcp"];
if (targetPath) {
  args.push("--path", targetPath);
}

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: process.env,
  cwd: targetPath || process.cwd(),
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  process.stderr.write(`[scout codegraph mcp] ${error.stack ?? error.message}\n`);
  process.exit(1);
});
