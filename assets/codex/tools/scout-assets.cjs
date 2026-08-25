#!/usr/bin/env node

const { existsSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { isAbsolute, join, resolve } = require("node:path");

const MARKER = "SCOUT_ASSETS_OK";

function main(argv) {
  const [command = "summary", ...args] = argv;
  if (command === "--smoke") {
    requireArgumentCount(command, args, 0);
    const manifest = readMountManifest();
    process.stdout.write(`${MARKER} assetCommitId=${manifest.assetCommitId}\n`);
    return;
  }

  const manifest = readMountManifest();
  if (command === "summary") {
    requireArgumentCount(command, args, 0);
    return printSummary(manifest);
  }
  if (command === "family") return printFamily(manifest, args);
  if (command === "skill") return printSkill(manifest, args);
  if (command === "plugin") return printPlugin(manifest, args);
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

function printSummary(manifest) {
  printJson({
    identity: {
      agentId: manifest.agentId,
      phase: manifest.agentProfile?.phase,
      mountRoot: manifest.mountRoot,
      mountId: manifest.mountId,
    },
    roots: {
      runtimeRoots: manifest.runtimeRoots ?? [],
      profileRoots: projectProfileRoots(manifest),
    },
    counts: {
      skills: (manifest.skills ?? []).length,
      shellTools: (manifest.shellTools ?? []).length,
      mcpServers: (manifest.mcpServers ?? []).length,
      plugins: (manifest.plugins ?? []).length,
      issues: (manifest.issues ?? []).length,
    },
  });
}

function printFamily(manifest, args) {
  requireArgumentRange("family", args, 0, 1);
  const nodes = buildFamilyNodes(manifest);
  if (args.length === 0) {
    return printJson({
      phase: manifest.agentProfile?.phase,
      families: [...new Set(nodes.map((node) => node.name))].sort(),
    });
  }

  const requested = args[0];
  const matches = requested.includes("/")
    ? nodes.filter((node) => node.path === requested)
    : nodes.filter((node) => node.name === requested);
  if (matches.length === 0) {
    fail(`Family is not supported for the current phase: ${requested}`);
  }
  if (matches.length > 1) {
    return printJson({
      phase: manifest.agentProfile?.phase,
      family: requested,
      ambiguous: true,
      candidates: matches.map((node) => node.path).sort(),
    });
  }

  const node = matches[0];
  const output = {
    phase: manifest.agentProfile?.phase,
    family: node.path,
  };
  if (node.children.size > 0) output.children = [...node.children].sort();
  if (node.skills.length > 0) output.skills = node.skills;
  return printJson(output);
}

function printSkill(manifest, args) {
  requireArgumentCount("skill", args, 1);
  const skill = (manifest.skills ?? []).find((candidate) => candidate.name === args[0]);
  if (!skill) fail(`Skill is not materialized for the current role: ${args[0]}`);
  printJson({
    skill,
    phaseTools: {
      skills: (manifest.skills ?? [])
        .filter((candidate) => candidate.family?.[0] === "tool")
        .map(projectSkillIdentity),
      shellTools: projectShellTools(manifest),
      mcpServers: projectMcpServers(manifest),
    },
  });
}

function printPlugin(manifest, args) {
  requireArgumentCount("plugin", args, 1);
  const name = args[0];
  if (!(manifest.plugins ?? []).includes(name)) {
    fail(`Plugin is not materialized for the current role: ${name}`);
  }
  const metadataPath = join(process.cwd(), "plugins", name, ".codex-plugin", "plugin.json");
  if (!existsSync(metadataPath)) {
    fail(`Plugin metadata is missing for the current role: ${name}`);
  }
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch (error) {
    fail(`Failed to read plugin metadata for ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  printJson({
    plugin: {
      name,
      path: `plugins/${name}`,
      metadata,
    },
  });
}

function buildFamilyNodes(manifest) {
  const nodes = new Map();
  for (const skill of manifest.skills ?? []) {
    const family = skill.family ?? [];
    for (let index = 0; index < family.length; index += 1) {
      const path = family.slice(0, index + 1).join("/");
      const node = nodes.get(path) ?? {
        path,
        name: family[index],
        children: new Set(),
        skills: [],
      };
      if (index === family.length - 1) node.skills.push(projectSkillIdentity(skill));
      nodes.set(path, node);
      if (index > 0) {
        const parent = nodes.get(family.slice(0, index).join("/"));
        parent?.children.add(family[index]);
      }
    }
  }
  return [...nodes.values()];
}

function projectSkillIdentity(skill) {
  return {
    name: skill.name,
    family: skill.family,
    path: skill.path,
  };
}

function projectShellTools(manifest) {
  return (manifest.shellTools ?? []).map((tool) => ({
    id: tool.id,
    exposeAs: tool.exposeAs,
    required: tool.required,
    wrapperPath: tool.wrapperPath,
    command: tool.command,
    commandPathKind: commandPathKind(tool.command),
  }));
}

function projectProfileRoots(manifest) {
  const readableRoots = new Set(manifest.profileReadableRoots ?? []);
  const writableRoots = new Set(manifest.profileWritableRoots ?? []);
  return [...new Set([...readableRoots, ...writableRoots])].map((source) => ({
    source,
    path: resolveProfileRoot(source),
    access: writableRoots.has(source)
      ? readableRoots.has(source) ? "read-write" : "write"
      : "read",
  }));
}

function resolveProfileRoot(source) {
  const mountRoot = process.cwd();
  const values = {
    SCOUT_ROOT: resolve(mountRoot, "../../../../../"),
    SCOUT_RUN_ROOT: resolve(mountRoot, "../../../../"),
    SCOUT_MOUNT_ROOT: mountRoot,
    SCOUT_ARTIFACT_ROOT: resolve(mountRoot, "../artifacts"),
    SCOUT_TEMP_ROOT: resolve(mountRoot, "../tmp"),
  };
  const expanded = source.replace(/\$\{([A-Za-z0-9_.]+)\}/g, (match, key) => values[key] ?? match);
  if (expanded === "~") return homedir();
  if (expanded.startsWith("~/")) return resolve(homedir(), expanded.slice(2));
  return isAbsolute(expanded) ? resolve(expanded) : resolve(values.SCOUT_ROOT, expanded);
}

function commandPathKind(command) {
  if (isAbsolute(command)) return "absolute";
  if (command.startsWith("assets/")) return "asset-relative";
  return "path-resolved";
}

function projectMcpServers(manifest) {
  return (manifest.mcpServers ?? []).map((server) => ({
    name: server.name,
    wrapperPath: server.wrapperPath,
    writableRoots: server.writableRoots ?? [],
    smoke: server.smoke,
  }));
}

function requireArgumentCount(command, args, expected) {
  if (args.length !== expected) {
    fail(`scout-assets ${command} expects ${expected} argument${expected === 1 ? "" : "s"}.`);
  }
}

function requireArgumentRange(command, args, minimum, maximum) {
  if (args.length < minimum || args.length > maximum) {
    fail(`scout-assets ${command} expects ${minimum}-${maximum} arguments.`);
  }
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(code) {
  const out = code === 0 ? process.stdout : process.stderr;
  out.write([
    "Usage:",
    "  scout-assets",
    "  scout-assets summary",
    "  scout-assets family [family-name|family-path]",
    "  scout-assets skill <skill-name>",
    "  scout-assets plugin <plugin-name>",
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
