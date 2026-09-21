import {
  lstatSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Supplies Codex configuration, authentication, and launch environment for one model provider. */
export interface CodexModelProvider {
  readonly id: string;
  configLines(): string[];
  prepareAuth(isolatedCodexHome: string): void;
  launchEnvironment(): NodeJS.ProcessEnv;
}

/** Uses Codex's built-in OpenAI provider and the current Codex authentication. */
export class OpenAIProvider implements CodexModelProvider {
  readonly id = "openai";

  constructor(private readonly authPath: string) {}

  configLines(): string[] {
    return [];
  }

  prepareAuth(isolatedCodexHome: string): void {
    rebindCodexAuth(isolatedCodexHome, this.authPath);
  }

  launchEnvironment(): NodeJS.ProcessEnv {
    return {};
  }
}

/** Uses one custom provider declared in the current Codex configuration. */
export class CustomCodexModelProvider implements CodexModelProvider {
  constructor(
    readonly id: string,
    private readonly config: {
      name?: string;
      baseUrl?: string;
      envKey?: string;
      bearerToken?: string;
      environmentCredential?: string;
      requiresOpenaiAuth?: boolean;
      supportsWebsockets?: boolean;
      wireApi?: string;
      authPath?: string;
    },
  ) {}

  configLines(): string[] {
    const lines = [
      `[model_providers.${this.id}]`,
      `name = "${escapeToml(this.config.name ?? this.id)}"`,
    ];
    if (this.config.baseUrl !== undefined) {
      lines.push(`base_url = "${escapeToml(this.config.baseUrl)}"`);
    }
    if (this.config.requiresOpenaiAuth !== undefined) {
      lines.push(`requires_openai_auth = ${this.config.requiresOpenaiAuth}`);
    }
    if (this.config.supportsWebsockets !== undefined) {
      lines.push(`supports_websockets = ${this.config.supportsWebsockets}`);
    }
    const providerEnvKey = this.config.bearerToken
      ? "CODEX_API_KEY"
      : this.config.envKey;
    if (providerEnvKey) {
      lines.push(`env_key = "${escapeToml(providerEnvKey)}"`);
    }
    lines.push(
      `wire_api = "${escapeToml(this.config.wireApi ?? "responses")}"`,
      "",
    );
    return lines;
  }

  prepareAuth(isolatedCodexHome: string): void {
    rebindCodexAuth(isolatedCodexHome, this.config.authPath);
  }

  launchEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    const apiKey = this.config.bearerToken ?? this.config.environmentCredential;
    if (apiKey) environment.CODEX_API_KEY = apiKey;
    if (this.config.baseUrl) environment.OPENAI_BASE_URL = this.config.baseUrl;
    return environment;
  }
}

/** Resolves and validates one provider from the current Codex home. */
export function resolveCodexModelProvider(providerName: string): CodexModelProvider {
  const codexHome = join(homedir(), ".codex");
  const authPath = join(codexHome, "auth.json");
  const hasCodexAuth = hasUsableCodexAuth(authPath);
  if (providerName === "openai") {
    if (!hasCodexAuth) {
      throw new Error(
        `Codex built-in model provider "openai" has no usable authentication at ${authPath}.`,
      );
    }
    return new OpenAIProvider(authPath);
  }

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
  const bearerToken = bearerTokenMatch?.[1];
  if (bearerTokenMatch && !bearerToken?.trim()) {
    throw new Error(
      `Codex model provider "${providerName}" has an empty experimental_bearer_token.`,
    );
  }
  const requiresOpenaiAuth = readOptionalBoolean(
    block,
    providerName,
    "requires_openai_auth",
  );
  const supportsWebsockets = readOptionalBoolean(
    block,
    providerName,
    "supports_websockets",
  );
  const environmentCredential = envKey === undefined
    ? undefined
    : process.env[envKey]?.trim();
  const canUseCodexAuth = requiresOpenaiAuth === true && hasCodexAuth;
  if (!bearerToken?.trim() && !environmentCredential && !canUseCodexAuth) {
    throw new Error(
      `Codex model provider "${providerName}" has no usable authentication. Configure a non-empty experimental_bearer_token, set the environment variable named by env_key, or provide usable Codex auth when requires_openai_auth is true.`,
    );
  }

  return new CustomCodexModelProvider(providerName, {
    name,
    baseUrl,
    envKey,
    bearerToken,
    environmentCredential,
    requiresOpenaiAuth,
    supportsWebsockets,
    wireApi: block.match(/^wire_api\s*=\s*"([^"]*)"/m)?.[1],
    authPath: !bearerToken?.trim() && !environmentCredential && canUseCodexAuth
      ? authPath
      : undefined,
  });
}

function hasUsableCodexAuth(authPath: string): boolean {
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
}

function readOptionalBoolean(
  block: string,
  providerName: string,
  key: "requires_openai_auth" | "supports_websockets",
): boolean | undefined {
  const assignment = new RegExp(`^${key}\\s*=`, "m").test(block);
  const value = block.match(
    new RegExp(`^${key}\\s*=\\s*(true|false)\\s*(?:#.*)?$`, "m"),
  )?.[1];
  if (assignment && value === undefined) {
    throw new Error(`Codex model provider "${providerName}" has an invalid ${key} value.`);
  }
  return value === undefined ? undefined : value === "true";
}

function rebindCodexAuth(isolatedCodexHome: string, targetAuthPath?: string): void {
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

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
