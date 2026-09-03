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

function readManifestDomain(manifest) {
  if (typeof manifest.domain !== "string" || manifest.domain.length === 0) {
    fail("mount manifest does not declare a workflow domain.");
  }
  return manifest.domain;
}

function printSummary(manifest) {
  const domain = readManifestDomain(manifest);
  printJson({
    identity: {
      agentId: manifest.agentId,
      mountRoot: manifest.mountRoot,
    },
    profile: {
      domain,
      phases: manifest.agentProfile?.phases ?? [],
      resourceParks: manifest.agentProfile?.resourceParks ?? [],
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
  const domain = readManifestDomain(manifest);
  const query = parseFamilyArguments(args);
  const phases = [...new Set(manifest.agentProfile?.phases ?? [])];
  if (query.phase !== undefined && !phases.includes(query.phase)) {
    fail(`Phase is not supported for the current role: ${query.phase}`);
  }

  const phaseSkills = buildPhaseSkillSets(manifest, phases, domain);
  const selectedGroups = query.phase === undefined
    ? buildPhaseGroups(phases, phaseSkills, manifest.skills ?? [])
    : [{ key: query.phase, phases: [query.phase], skills: phaseSkills.get(query.phase) ?? [] }];
  const base = {};

  if (query.requested === undefined) {
    if (query.phase !== undefined) {
      return printJson({
        ...base,
        phase: query.phase,
        ...projectFamilyGroup(selectedGroups[0].skills),
      });
    }
    const output = { ...base };
    for (const group of selectedGroups) {
      const projected = projectFamilyGroup(group.skills);
      if (Object.keys(projected).length > 0) output[group.key] = projected;
    }
    return printJson(output);
  }

  const matchesByGroup = selectedGroups.map((group) => ({
    ...group,
    matches: findFamilyNodes(group.skills, query.requested),
  })).filter((group) => group.matches.length > 0);
  const candidatePaths = [...new Set(
    matchesByGroup.flatMap((group) => group.matches.map((node) => node.familyPath)),
  )].sort();
  if (candidatePaths.length === 0) {
    fail(`Family is not supported for the current role: ${query.requested}`);
  }
  if (candidatePaths.length > 1) {
    const output = {
      ...base,
      family: query.requested,
      ambiguous: true,
    };
    if (query.phase !== undefined) {
      output.phase = query.phase;
      output.candidates = candidatePaths;
      return printJson(output);
    }
    for (const group of matchesByGroup) {
      const candidates = [...new Set(group.matches.map((node) => node.familyPath))].sort();
      if (candidates.length > 0) output[group.key] = { candidates };
    }
    return printJson(output);
  }

  const familyPath = candidatePaths[0];
  const output = {
    ...base,
    family: familyPath,
  };
  if (query.phase !== undefined) output.phase = query.phase;
  for (const group of matchesByGroup) {
    const node = group.matches.find((candidate) => candidate.familyPath === familyPath);
    if (!node) continue;
    const projected = projectFamilyNode(node);
    if (query.phase !== undefined) {
      Object.assign(output, projected);
    } else {
      output[group.key] = projected;
    }
  }
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

function buildFamilyNodes(skills) {
  const nodes = new Map();
  for (const skill of skills ?? []) {
    const family = skill.family ?? [];
    for (let index = 0; index < family.length; index += 1) {
      const path = family.slice(0, index + 1).join("/");
      const node = nodes.get(path) ?? {
        path,
        familyPath: family.slice(0, index + 1).join("."),
        name: family[index],
        children: new Set(),
        skills: [],
      };
      if (index === family.length - 1) node.skills.push(projectSkillIdentity(skill));
      nodes.set(path, node);
      if (index > 0) {
        const parent = nodes.get(family.slice(0, index).join("/"));
        parent?.children.add(family.slice(0, index + 1).join("."));
      }
    }
  }
  return [...nodes.values()];
}

function parseFamilyArguments(args) {
  let requested;
  let phase;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--phase") {
      if (phase !== undefined || index + 1 >= args.length || args[index + 1].startsWith("--")) {
        fail("scout-assets family expects one value after --phase.");
      }
      phase = args[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      fail(`Unknown scout-assets family option: ${argument}`);
    }
    if (requested !== undefined) {
      fail("scout-assets family expects at most one family name or path.");
    }
    requested = argument;
  }
  return { requested, phase };
}

function buildPhaseSkillSets(manifest, phases, domain) {
  const byName = new Map((manifest.skills ?? []).map((skill) => [skill.name, skill]));
  const result = new Map();
  for (const phase of phases) {
    const selected = new Set();
    const queue = (manifest.skills ?? [])
      .filter((skill) => isRootSkillForPhase(skill, domain, phase))
      .map((skill) => skill.name);
    while (queue.length > 0) {
      const name = queue.shift();
      if (selected.has(name)) continue;
      const skill = byName.get(name);
      if (!skill) continue;
      selected.add(name);
      for (const dependency of [
        ...(skill.requiredSkills ?? []),
        ...(skill.optionalSkills ?? []),
      ]) {
        if (!selected.has(dependency)) queue.push(dependency);
      }
    }
    result.set(phase, [...selected].map((name) => byName.get(name)).filter(Boolean));
  }
  return result;
}

function isRootSkillForPhase(skill, domain, phase) {
  if (skill.type === "internal") return true;
  return skill.type === "domain"
    && skill.domain === domain
    && Array.isArray(skill.phase)
    && skill.phase.includes(phase);
}

function buildPhaseGroups(phases, phaseSkills, allSkills) {
  const allPhases = [...phases];
  const memberships = new Map();
  for (const phase of allPhases) {
    for (const skill of phaseSkills.get(phase) ?? []) {
      const membership = memberships.get(skill.name) ?? [];
      membership.push(phase);
      memberships.set(skill.name, membership);
    }
  }
  const groups = new Map();
  for (const [skillName, membership] of memberships) {
    const key = membership.join("+");
    const group = groups.get(key) ?? {
      key,
      phases: membership,
      skills: [],
    };
    const skill = allSkills.find((candidate) => candidate.name === skillName);
    if (skill) group.skills.push(skill);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => {
    if (left.phases.length !== right.phases.length) return right.phases.length - left.phases.length;
    return left.key.localeCompare(right.key);
  });
}

function projectFamilyGroup(skills) {
  const nodes = buildFamilyNodes(skills);
  const output = {};
  const families = nodes.map((node) => node.familyPath).sort();
  if (families.length > 0) output.families = families;
  return output;
}

function findFamilyNodes(skills, requested) {
  const nodes = buildFamilyNodes(skills);
  return requested.includes(".")
    ? nodes.filter((node) => node.familyPath === requested)
    : nodes.filter((node) => node.name === requested);
}

function projectFamilyNode(node) {
  if (node.children.size > 0) return { children: [...node.children].sort() };
  if (node.skills.length > 0) return { skills: node.skills };
  return {};
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
    "  scout-assets family [family-name|family-path] [--phase phase]",
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
