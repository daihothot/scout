#!/usr/bin/env node

const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const MARKER = "SCOUT_ASSETS_OK";

function main(argv) {
  const [command = "list"] = argv;
  if (command === "--smoke") {
    const manifest = readMountManifest();
    process.stdout.write(`${MARKER} assetCommitId=${manifest.assetCommitId}\n`);
    return;
  }

  const manifest = readMountManifest();
  if (command === "list") return printList(manifest);
  if (command === "skills") return printJson({ skills: manifest.skills ?? [] });
  if (command === "tools") return printJson({ shellTools: manifest.shellTools ?? [] });
  if (command === "mcp") return printJson({ mcpServers: manifest.mcpServers ?? [] });
  if (command === "plugins") return printJson({ plugins: manifest.plugins ?? [] });
  if (command === "raw") return printJson(manifest);
  usage(1);
}

function readMountManifest() {
  const manifestPath = resolve(process.cwd(), "mount-manifest.json");
  if (!existsSync(manifestPath)) {
    fail(`mount-manifest.json not found at ${manifestPath}. Run scout-assets from the mount root.`);
  }
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`Failed to read mount manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function printList(manifest) {
  printJson({
    assetCommitId: manifest.assetCommitId,
    mountId: manifest.mountId,
    agentId: manifest.agentId,
    agentProfile: manifest.agentProfile,
    generatedAt: manifest.generatedAt,
    skills: manifest.skills ?? [],
    workerAgent: manifest.workerAgent,
    roleAgents: manifest.roleAgents ?? {},
    plugins: manifest.plugins ?? [],
    shellTools: (manifest.shellTools ?? []).map((tool) => ({
      id: tool.id,
      exposeAs: tool.exposeAs,
      required: tool.required,
      wrapperPath: tool.wrapperPath,
    })),
    mcpServers: (manifest.mcpServers ?? []).map((server) => ({
      name: server.name,
      wrapperPath: server.wrapperPath,
      trustedRoots: server.trustedRoots ?? [],
      writableRoots: server.writableRoots ?? [],
      smoke: server.smoke,
    })),
  });
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(code) {
  const out = code === 0 ? process.stdout : process.stderr;
  out.write([
    "Usage:",
    "  scout-assets list",
    "  scout-assets skills",
    "  scout-assets tools",
    "  scout-assets mcp",
    "  scout-assets plugins",
    "  scout-assets raw",
    "  scout-assets --smoke",
    "",
  ].join("\n"));
  process.exit(code);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main(process.argv.slice(2));
