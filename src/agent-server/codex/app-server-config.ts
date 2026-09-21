import { resolve } from "node:path";
import type { CodexModelConfig } from "./model-config.js";
import type { CodexModelProvider } from "./model-provider.js";

/** Renders the isolated Codex configuration for one Scout run. */
export function buildClientConfig(input: {
  mountRoots: string[];
  permissionProfiles: Partial<Record<string, {
    id: string;
    readableRoots: string[];
    writableRoots: string[];
    deniedRoots: string[];
    network: boolean;
  }>>;
  model: CodexModelConfig;
  provider: CodexModelProvider;
}): string {
  const mountRoots = uniqueResolved(input.mountRoots);
  const lines = [
    'default_permissions = ":read-only"',
    `model = "${escapeToml(input.model.id)}"`,
    `model_provider = "${escapeToml(input.provider.id)}"`,
    `model_reasoning_effort = "${input.model.reasoningEffort}"`,
    `model_reasoning_summary = "${input.model.reasoningSummary}"`,
    "",
    "[features]",
    "apps = false",
    "remote_plugin = false",
    "shell_snapshot = false",
    "",
    ...input.provider.configLines(),
  ];
  for (const profile of Object.values(input.permissionProfiles)) {
    if (!profile) continue;
    lines.push(
      `[permissions.${profile.id}.filesystem]`,
      '":minimal" = "read"',
    );
    const rules = new Map<string, "read" | "write" | "deny">();
    for (const root of profile.readableRoots) rules.set(root, "read");
    for (const root of profile.writableRoots) rules.set(root, "write");
    for (const root of profile.deniedRoots) rules.set(root, "deny");
    for (const [root, access] of [...rules].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`"${escapeToml(root)}" = "${access}"`);
    }
    lines.push(
      "",
      `[permissions.${profile.id}.network]`,
      `enabled = ${profile.network}`,
      "",
    );
  }
  for (const mountRoot of mountRoots) {
    lines.push(
      `[projects."${escapeToml(mountRoot)}"]`,
      'trust_level = "trusted"',
      "",
    );
  }
  return lines.join("\n");
}

function uniqueResolved(roots: string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))].sort();
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
