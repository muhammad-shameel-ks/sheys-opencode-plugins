import crypto from "node:crypto";
import { readEnvVar, readIntegrationConnections, type ResolvedConnection } from "../auth.js";
import { clampPercent, finiteNumber, isRecord, nonEmptyString, requestJson, toIsoTimestamp } from "../http.js";
import type { LimitRow, ProviderLimits } from "../types.js";
import type { ProviderContext } from "./types.js";

const AGY_QUOTA_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const GEMINI_CLI_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";

const AGY_AUTH_IDS = ["google-agy", "opencode-agy-auth", "google-agy-auth", "google"];
const GEMINI_AUTH_IDS = ["google-gemini-cli", "gemini-cli", "opencode-gemini-auth", "gemini", "google"];

function extractProjectId(conn: ResolvedConnection, envVars: readonly string[]): string | undefined {
  const packed = (conn.refreshToken ?? "").split("|");
  return (
    nonEmptyString(conn.fields.managedProjectId) ??
    nonEmptyString(conn.fields.quotaProjectId) ??
    nonEmptyString(packed[2]) ??
    nonEmptyString(conn.fields.projectId) ??
    nonEmptyString(conn.fields.projectID) ??
    nonEmptyString(packed[1]) ??
    readEnvVar(envVars)
  );
}

function isAntigravityConnection(conn: ResolvedConnection): boolean {
  if (conn.integrationId !== "google") return true;
  return conn.methodID === "antigravity" || Boolean(conn.fields.antigravity);
}

function isGeminiCliConnection(conn: ResolvedConnection): boolean {
  if (conn.integrationId !== "google") return true;
  return conn.methodID !== "antigravity";
}

export function parseAgyQuotaResponse(json: unknown): { readonly rows: LimitRow[] } | { readonly error: string } {
  if (!isRecord(json)) return { error: "Unexpected Google AGY response" };

  const deduped = new Map<string, LimitRow>();
  const addBuckets = (buckets: unknown, familyName: string) => {
    if (!Array.isArray(buckets)) return;
    for (const bucket of buckets) {
      if (!isRecord(bucket) || bucket.disabled === true) continue;
      const winRaw = nonEmptyString(bucket.window)?.toUpperCase().replace(/[\s-]+/g, "_");
      const winLabel = winRaw === "WEEKLY" ? "Weekly" : winRaw === "FIVE_HOUR" || winRaw === "5H" ? "5h" : undefined;
      const remFraction = finiteNumber(bucket.remainingFraction);
      if (!winLabel || remFraction === undefined) continue;

      const lowerFamily = familyName.toLowerCase();
      const shortFamily =
        lowerFamily === "gemini" || lowerFamily === "gemini models"
          ? "Gemini"
          : lowerFamily.includes("claude") && lowerFamily.includes("gpt")
            ? "Claude/GPT"
            : familyName;

      const label = `${shortFamily} ${winLabel}`;
      const percentUsed = clampPercent((1 - Math.min(1, Math.max(0, remFraction))) * 100);
      const resetsAt = toIsoTimestamp(bucket.resetTime);
      const existing = deduped.get(label);
      if (!existing || (existing.percentUsed ?? 0) < percentUsed) {
        deduped.set(label, { label, percentUsed, resetsAt });
      }
    }
  };

  if (Array.isArray(json.groups)) {
    for (const group of json.groups) {
      if (!isRecord(group)) continue;
      const displayName = nonEmptyString(group.displayName);
      if (displayName) addBuckets(group.buckets, displayName);
    }
  }
  if (deduped.size === 0 && Array.isArray(json.buckets)) {
    addBuckets(json.buckets, nonEmptyString(json.description) ?? "Quota");
  }

  const rows = [...deduped.values()];
  return rows.length > 0 ? { rows } : { error: "No Google AGY quota data available" };
}

function qualityTier(modelId: string): string {
  const lower = modelId.toLowerCase().replace(/_/g, "-");
  if (lower.includes("flash-lite")) return "Gemini Flash Lite";
  if (/\bpro\b/.test(lower)) return "Gemini Pro";
  if (/\bflash\b/.test(lower)) return "Gemini Flash";
  return modelId;
}

export function parseGeminiCliQuotaResponse(json: unknown): { readonly rows: LimitRow[] } | { readonly error: string } {
  if (!isRecord(json) || !Array.isArray(json.buckets)) {
    return { error: "Unexpected Gemini CLI response" };
  }

  const byTier = new Map<string, LimitRow>();
  for (const bucket of json.buckets) {
    if (!isRecord(bucket)) continue;
    const modelId = nonEmptyString(bucket.modelId);
    const remFraction = finiteNumber(bucket.remainingFraction);
    if (!modelId || remFraction === undefined) continue;

    const label = qualityTier(modelId);
    const percentUsed = clampPercent((1 - Math.min(1, Math.max(0, remFraction))) * 100);
    const resetsAt = toIsoTimestamp(bucket.resetTime);
    const existing = byTier.get(label);
    if (!existing || (existing.percentUsed ?? 0) < percentUsed) {
      byTier.set(label, { label, percentUsed, resetsAt });
    }
  }

  const ordered = ["Gemini Pro", "Gemini Flash", "Gemini Flash Lite"];
  const rows = [
    ...ordered.flatMap((tier) => {
      const row = byTier.get(tier);
      byTier.delete(tier);
      return row ? [row] : [];
    }),
    ...byTier.values(),
  ];

  return rows.length > 0 ? { rows } : { error: "No Gemini CLI quota data available" };
}

async function queryGoogleQuotaEndpoint(params: {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly conn: ResolvedConnection;
  readonly projectEnvVars: readonly string[];
  readonly parse: (json: unknown) => { readonly rows: LimitRow[] } | { readonly error: string };
  readonly fetchImpl?: typeof fetch;
}): Promise<ProviderLimits | undefined> {
  const { conn } = params;
  if (conn.resolveError) {
    return {
      id: params.id,
      name: params.name,
      status: "error",
      rows: [],
      error: `Sign-in failed: ${conn.resolveError}`,
    };
  }
  if (!conn.accessToken) return undefined;

  const projectId = extractProjectId(conn, params.projectEnvVars);
  const account = nonEmptyString(conn.fields.email) ?? nonEmptyString(conn.fields.accountEmail);
  if (!projectId) {
    return {
      id: params.id,
      name: params.name,
      account,
      status: "error",
      rows: [],
      error: `Missing GCP projectId (set ${params.projectEnvVars[0]})`,
    };
  }

  const reply = await requestJson(params.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${conn.accessToken}`,
      ...params.headers,
    },
    body: JSON.stringify({ project: projectId }),
    secrets: [conn.accessToken],
    fetchImpl: params.fetchImpl,
  });

  if (!reply.ok) {
    return {
      id: params.id,
      name: params.name,
      account,
      status: "error",
      rows: [],
      error:
        reply.kind === "http" && (reply.status === 401 || reply.status === 403)
          ? `Auth rejected (${reply.status}) — re-login required`
          : reply.kind === "http"
            ? `HTTP ${reply.status}: ${reply.detail}`
            : reply.detail,
    };
  }

  const parsed = params.parse(reply.json);
  if ("error" in parsed) {
    return { id: params.id, name: params.name, account, status: "error", rows: [], error: parsed.error };
  }

  return {
    id: params.id,
    name: params.name,
    account,
    status: "ok",
    rows: parsed.rows,
  };
}

export async function fetchGoogleAgy(pctx: ProviderContext): Promise<ProviderLimits | undefined> {
  const conns = (await readIntegrationConnections(pctx.ctx, AGY_AUTH_IDS, ["oauth"])).filter(isAntigravityConnection);
  const active = conns.find((c) => c.active) ?? conns[0];
  if (!active) return undefined;

  return queryGoogleQuotaEndpoint({
    id: "google-agy",
    name: "Google AGY",
    url: AGY_QUOTA_URL,
    headers: {
      "User-Agent": "antigravity/cli/1.4.12 darwin/amd64",
      "x-activity-request-id": crypto.randomUUID(),
    },
    conn: active,
    projectEnvVars: ["OPENCODE_AGY_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT_ID"],
    parse: parseAgyQuotaResponse,
    fetchImpl: pctx.fetchImpl,
  });
}

export async function fetchGoogleGeminiCli(pctx: ProviderContext): Promise<ProviderLimits | undefined> {
  const conns = (await readIntegrationConnections(pctx.ctx, GEMINI_AUTH_IDS, ["oauth"])).filter(isGeminiCliConnection);
  const active = conns.find((c) => c.active) ?? conns[0];
  if (!active) return undefined;

  return queryGoogleQuotaEndpoint({
    id: "google-gemini-cli",
    name: "Gemini CLI",
    url: GEMINI_CLI_QUOTA_URL,
    headers: {
      "User-Agent": `GeminiCLI/opencode-limits (${process.platform}; ${process.arch})`,
    },
    conn: active,
    projectEnvVars: ["OPENCODE_GEMINI_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT_ID"],
    parse: parseGeminiCliQuotaResponse,
    fetchImpl: pctx.fetchImpl,
  });
}
