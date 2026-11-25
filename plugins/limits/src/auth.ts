import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { isRecord, nonEmptyString } from "./http.js";

export interface ResolvedConnection {
  readonly integrationId: string;
  readonly id: string;
  readonly label: string;
  readonly active: boolean;
  readonly method: "oauth" | "api";
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly apiKey?: string;
  readonly accountId?: string;
  readonly orgId?: string;
  readonly server?: string;
  readonly methodID?: string;
  readonly fields: Record<string, unknown>;
  readonly resolveError?: string;
}

export function readEnvVar(names: readonly string[]): string | undefined {
  for (const name of names) {
    const val = nonEmptyString(process.env[name]);
    if (val) return val;
  }
  return undefined;
}

function flattenCredentialValue(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const metadata = isRecord(raw.metadata) ? raw.metadata : {};
  const flat: Record<string, unknown> = { ...metadata, ...raw };
  if (flat.type === "key") flat.type = "api";
  return flat;
}

export async function readIntegrationConnections(
  ctx: Plugin.Context,
  integrationIds: readonly string[],
  allowedMethods?: readonly ("oauth" | "api")[],
): Promise<ResolvedConnection[]> {
  let listedByIntegration: Map<string, Awaited<ReturnType<typeof ctx.integration.list>>["data"][number]["connections"]> | undefined;
  try {
    const { data } = await ctx.integration.list();
    listedByIntegration = new Map(data.map((entry) => [entry.id, entry.connections]));
  } catch {
    listedByIntegration = undefined;
  }

  const results: ResolvedConnection[] = [];

  for (const integrationId of integrationIds) {
    let activeConnId: string | undefined;
    try {
      const active = await ctx.integration.connection.active(integrationId);
      if (active?.type === "credential") {
        activeConnId = active.id;
      }
    } catch {
      activeConnId = undefined;
    }

    let connections = listedByIntegration
      ?.get(integrationId)
      ?.filter((c) => c.type === "credential");

    if (!connections) {
      try {
        const active = await ctx.integration.connection.active(integrationId);
        connections = active?.type === "credential" ? [active] : [];
      } catch {
        connections = [];
      }
    }

    for (const connection of connections) {
      if (connection.type !== "credential") continue;
      const mappedMethod: "oauth" | "api" | undefined =
        connection.method === "oauth"
          ? "oauth"
          : connection.method === "key"
            ? "api"
            : undefined;
      if (!mappedMethod) continue;
      if (allowedMethods && !allowedMethods.includes(mappedMethod)) continue;

      try {
        const resolved = await ctx.integration.connection.resolve(connection);
        if (!resolved) continue;
        const fields = flattenCredentialValue(resolved);
        const type = fields.type === "oauth" ? "oauth" : "api";
        if (allowedMethods && !allowedMethods.includes(type)) continue;

        results.push({
          integrationId,
          id: connection.id,
          label: connection.label,
          active: connection.id === activeConnId || connections.length === 1,
          method: type,
          accessToken: nonEmptyString(fields.access),
          refreshToken: nonEmptyString(fields.refresh),
          expiresAt: typeof fields.expires === "number" && Number.isFinite(fields.expires) ? fields.expires : undefined,
          apiKey: nonEmptyString(fields.key),
          accountId: nonEmptyString(fields.accountID) ?? nonEmptyString(fields.accountId),
          orgId: nonEmptyString(fields.orgID) ?? nonEmptyString(fields.orgId),
          server: nonEmptyString(fields.server),
          methodID: nonEmptyString(fields.methodID),
          fields,
        });
      } catch (error) {
        results.push({
          integrationId,
          id: connection.id,
          label: connection.label,
          active: connection.id === activeConnId,
          method: mappedMethod,
          fields: {},
          resolveError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return results;
}

export async function readApiKeys(
  ctx: Plugin.Context,
  spec: { readonly envVars: readonly string[]; readonly integrationIds: readonly string[] },
): Promise<Array<{ readonly key: string; readonly label?: string }>> {
  const envKey = readEnvVar(spec.envVars);
  if (envKey) return [{ key: envKey }];

  const connections = await readIntegrationConnections(ctx, spec.integrationIds, ["api"]);
  const seen = new Set<string>();
  const keys: Array<{ readonly key: string; readonly label?: string }> = [];

  for (const conn of connections) {
    if (!conn.apiKey || seen.has(conn.apiKey)) continue;
    seen.add(conn.apiKey);
    const label = conn.label && !["default", "api key"].includes(conn.label.toLowerCase()) ? conn.label : undefined;
    keys.push({ key: conn.apiKey, ...(label ? { label } : {}) });
  }
  return keys;
}

function extractTokenFromClaudePayload(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!isRecord(parsed)) return undefined;
    for (const candidate of [parsed.claudeAiOauth, parsed.oauth, parsed]) {
      if (!isRecord(candidate)) continue;
      for (const key of ["accessToken", "access_token", "token"]) {
        const token = nonEmptyString(candidate[key]);
        if (token) return token;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readMacOSKeychainSecret(service: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { encoding: "utf8", timeout: 2_500 },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(undefined);
          return;
        }
        resolve(stdout.trim() || undefined);
      },
    );
  });
}

export async function readClaudeCliOAuthToken(): Promise<string | undefined> {
  const envToken = readEnvVar(["CLAUDE_CODE_OAUTH_TOKEN"]);
  if (envToken) return envToken;

  const keychainRaw = await readMacOSKeychainSecret("Claude Code-credentials");
  if (keychainRaw) {
    const token = extractTokenFromClaudePayload(keychainRaw);
    if (token) return token;
  }

  try {
    const content = await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8");
    return extractTokenFromClaudePayload(content);
  } catch {
    return undefined;
  }
}
