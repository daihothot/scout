import {
  lstatSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CodexModelConfig } from "./model-config.js";

/** Provider settings read from the user's Codex configuration. */
export interface CodexProviderConfig {
  name?: string;
  baseUrl?: string;
  envKey?: string;
  experimentalBearerToken?: string;
  requiresOpenaiAuth?: boolean;
  supportsWebsockets?: boolean;
  wireApi?: string;
  authPath?: string;
}

/** Renders the isolated Codex configuration for one Scout run. */
export function buildClientConfig(input: {
  mountRoots: string[];
  permissionProfiles: Partial<Record<string, {
    id: string;
    readableRoots: string[];
    writableRoots: string[];
    deniedRoots: string[];
  }>>;
  model: CodexModelConfig;
  providerConfig: CodexProviderConfig;
}): string {
  const homeConfig = input.providerConfig;
  const mountRoots = uniqueResolved(input.mountRoots);
  const providerLines = [
    `[model_providers.${input.model.provider}]`,
    `name = "${escapeToml(homeConfig.name ?? input.model.provider)}"`,
  ];
  if (homeConfig.baseUrl !== undefined) {
    providerLines.push(`base_url = "${escapeToml(homeConfig.baseUrl)}"`);
  }
  if (homeConfig.requiresOpenaiAuth !== undefined) {
    providerLines.push(`requires_openai_auth = ${homeConfig.requiresOpenaiAuth}`);
  }
  if (homeConfig.supportsWebsockets !== undefined) {
    providerLines.push(`supports_websockets = ${homeConfig.supportsWebsockets}`);
  }
  const providerEnvKey = homeConfig.experimentalBearerToken
    ? "CODEX_API_KEY"
    : homeConfig.envKey;
  if (providerEnvKey) {
    providerLines.push(`env_key = "${escapeToml(providerEnvKey)}"`);
  }
  providerLines.push(
    `wire_api = "${escapeToml(homeConfig.wireApi ?? "responses")}"`,
    "",
  );
  const lines = [
    'default_permissions = ":read-only"',
    `model = "${escapeToml(input.model.id)}"`,
    `model_provider = "${escapeToml(input.model.provider)}"`,
    `model_reasoning_effort = "${input.model.reasoningEffort}"`,
    `model_reasoning_summary = "${input.model.reasoningSummary}"`,
    "",
    "[features]",
    "apps = false",
    "remote_plugin = false",
    "shell_snapshot = false",
    "",
    ...providerLines,
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
      "enabled = false",
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

/** Reads and validates one provider block from the user's Codex config. */
export function readHomeProviderConfig(providerName: string): CodexProviderConfig {
  const codexHome = join(homedir(), ".codex");
  const configPath = join(codexHome, "config.toml");
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read Codex config for model provider "${providerName}" at ${configPath}.`,
      { cause: error },
    );
  }

  const block = readTomlTableBlock(text, `model_providers.${providerName}`);
  if (block.trim().length === 0) {
    throw new Error(
      `Codex model provider "${providerName}" is not configured in ${configPath}.`,
    );
  }

  const nameMatch = block.match(/^name\s*=\s*"([^"]*)"/m);
  const name = nameMatch?.[1]?.trim();
  if (nameMatch && !name) {
    throw new Error(`Codex model provider "${providerName}" has an empty name.`);
  }
  const baseUrlAssignment = /^base_url\s*=/m.test(block);
  const baseUrl = block.match(/^base_url\s*=\s*"([^"]*)"/m)?.[1]?.trim();
  if (baseUrlAssignment && !baseUrl) {
    throw new Error(`Codex model provider "${providerName}" has an invalid base_url.`);
  }
  if (baseUrl) {
    let parsedBaseUrl: URL;
    try {
      parsedBaseUrl = new URL(baseUrl);
    } catch {
      throw new Error(`Codex model provider "${providerName}" has an invalid base_url.`);
    }
    if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
      throw new Error(
        `Codex model provider "${providerName}" base_url must use http or https.`,
      );
    }
  }

  const envKeyMatch = block.match(/^env_key\s*=\s*"([^"]*)"/m);
  const envKey = envKeyMatch?.[1]?.trim();
  if (envKeyMatch && (!envKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey))) {
    throw new Error(`Codex model provider "${providerName}" has an invalid env_key.`);
  }
  const bearerTokenMatch = block.match(
    /^experimental_bearer_token\s*=\s*"([^"]*)"/m,
  );
  const experimentalBearerToken = bearerTokenMatch?.[1];
  if (bearerTokenMatch && !experimentalBearerToken?.trim()) {
    throw new Error(
      `Codex model provider "${providerName}" has an empty experimental_bearer_token.`,
    );
  }
  const requiresOpenaiAuthAssignment = /^requires_openai_auth\s*=/m.test(block);
  const requiresOpenaiAuthValue = block.match(
    /^requires_openai_auth\s*=\s*(true|false)\s*(?:#.*)?$/m,
  )?.[1];
  if (requiresOpenaiAuthAssignment && requiresOpenaiAuthValue === undefined) {
    throw new Error(
      `Codex model provider "${providerName}" has an invalid requires_openai_auth value.`,
    );
  }
  const requiresOpenaiAuth = requiresOpenaiAuthValue === undefined
    ? undefined
    : requiresOpenaiAuthValue === "true";
  const supportsWebsocketsAssignment = /^supports_websockets\s*=/m.test(block);
  const supportsWebsocketsValue = block.match(
    /^supports_websockets\s*=\s*(true|false)\s*(?:#.*)?$/m,
  )?.[1];
  if (supportsWebsocketsAssignment && supportsWebsocketsValue === undefined) {
    throw new Error(
      `Codex model provider "${providerName}" has an invalid supports_websockets value.`,
    );
  }
  const supportsWebsockets = supportsWebsocketsValue === undefined
    ? undefined
    : supportsWebsocketsValue === "true";

  const hasConfiguredEnvironmentCredential = envKey !== undefined
    && Boolean(process.env[envKey]?.trim());
  const authPath = join(codexHome, "auth.json");
  const hasCodexAuth = requiresOpenaiAuth === true && (() => {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
      if (typeof auth !== "object" || auth === null || Array.isArray(auth)) return false;
      const authRecord = auth as Record<string, unknown>;
      if (typeof authRecord.OPENAI_API_KEY === "string"
        && authRecord.OPENAI_API_KEY.trim().length > 0) {
        return true;
      }
      const tokens = authRecord.tokens;
      return typeof tokens === "object"
        && tokens !== null
        && !Array.isArray(tokens)
        && typeof (tokens as Record<string, unknown>).access_token === "string"
        && ((tokens as Record<string, unknown>).access_token as string).trim().length > 0;
    } catch {
      return false;
    }
  })();
  if (!experimentalBearerToken?.trim()
    && !hasConfiguredEnvironmentCredential
    && !hasCodexAuth) {
    throw new Error(
      `Codex model provider "${providerName}" has no usable authentication. Configure a non-empty experimental_bearer_token, set the environment variable named by env_key, or provide usable Codex auth when requires_openai_auth is true.`,
    );
  }

  return {
    name,
    baseUrl,
    envKey,
    experimentalBearerToken,
    requiresOpenaiAuth,
    supportsWebsockets,
    wireApi: block.match(/^wire_api\s*=\s*"([^"]*)"/m)?.[1],
    authPath: !experimentalBearerToken?.trim()
        && !hasConfiguredEnvironmentCredential
        && hasCodexAuth
      ? authPath
      : undefined,
  };
}

/** Rebinds the isolated run's Codex auth to the selected host configuration. */
export function rebindTargetCodexAuth(
  isolatedCodexHome: string,
  targetAuthPath?: string,
): void {
  const isolatedAuthPath = join(isolatedCodexHome, "auth.json");
  try {
    lstatSync(isolatedAuthPath);
    rmSync(isolatedAuthPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (targetAuthPath) symlinkSync(targetAuthPath, isolatedAuthPath);
}

function readTomlTableBlock(text: string, tableName: string): string {
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = text.match(new RegExp(`^\\[${escaped}\\]\\r?\\n`, "m"));
  if (!header || header.index === undefined) return "";
  const contentStart = header.index + header[0].length;
  const rest = text.slice(contentStart);
  const nextHeader = rest.search(/\r?\n\[/);
  return nextHeader === -1 ? rest : rest.slice(0, nextHeader);
}

function uniqueResolved(roots: string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))].sort();
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
