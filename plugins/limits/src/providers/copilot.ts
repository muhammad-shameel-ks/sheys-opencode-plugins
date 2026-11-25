import { readIntegrationConnections } from "../auth.js";
import { clampPercent, finiteNumber, isRecord, nonEmptyString, requestJson, toIsoTimestamp } from "../http.js";
import type { LimitRow, ProviderLimits } from "../types.js";
import type { ProviderContext } from "./types.js";

const COPILOT_AUTH_IDS = [
  "github-copilot",
  "copilot",
  "copilot-chat",
  "github-copilot-chat",
];

function validateEnterpriseHost(value: unknown): { readonly host?: string; readonly error?: string } {
  if (value === undefined || value === null) return {};
  const raw = nonEmptyString(value);
  if (!raw) return { error: "Invalid enterpriseUrl" };

  let host: string;
  if (raw.includes("://")) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:") return { error: "enterpriseUrl must use https" };
      host = url.hostname.toLowerCase();
    } catch {
      return { error: "Invalid enterpriseUrl" };
    }
  } else {
    host = raw.toLowerCase();
  }

  if (!host.endsWith(".ghe.com") || host.startsWith("api.")) {
    return { error: "Invalid enterpriseUrl host" };
  }
  return { host };
}

export function parseCopilotUserResponse(
  json: unknown,
): { readonly rows: LimitRow[]; readonly plan?: string } | { readonly error: string } {
  if (!isRecord(json)) return { error: "Unexpected GitHub Copilot response" };
  const plan = nonEmptyString(json.copilot_plan);
  const resetsAt = toIsoTimestamp(json.quota_reset_date_utc ?? json.quota_reset_date);
  const snapshots = isRecord(json.quota_snapshots) ? json.quota_snapshots : undefined;
  const premium = snapshots && isRecord(snapshots.premium_interactions) ? snapshots.premium_interactions : undefined;

  if (premium?.unlimited === true) {
    return {
      plan,
      rows: [{ label: "Premium", valueText: "Unlimited", resetsAt }],
    };
  }

  const entitlement = finiteNumber(premium?.entitlement);
  const remaining = finiteNumber(premium?.quota_remaining ?? premium?.remaining);
  const reportedRemainingPct = finiteNumber(premium?.percent_remaining);

  if (entitlement !== undefined && entitlement > 0 && remaining !== undefined) {
    const used = Math.max(0, entitlement - remaining);
    const percentUsed =
      reportedRemainingPct !== undefined && reportedRemainingPct >= 0 && reportedRemainingPct <= 100
        ? clampPercent(100 - reportedRemainingPct)
        : clampPercent((used / entitlement) * 100);
    return {
      plan,
      rows: [
        {
          label: "Premium",
          percentUsed,
          valueText: `${Math.round(used)}/${Math.round(entitlement)}`,
          resetsAt,
        },
      ],
    };
  }

  if (json.token_based_billing === true) {
    return {
      plan,
      rows: [{ label: "Plan", valueText: plan ?? "Active", resetsAt }],
    };
  }

  return { error: "GitHub Copilot response did not include a usable quota snapshot" };
}

export async function fetchCopilot(pctx: ProviderContext): Promise<ProviderLimits | undefined> {
  const { ctx, fetchImpl } = pctx;
  const conns = await readIntegrationConnections(ctx, COPILOT_AUTH_IDS, ["oauth"]);
  const active = conns.find((c) => c.active) ?? conns[0];
  if (!active) return undefined;

  if (active.resolveError) {
    return {
      id: "copilot",
      name: "GitHub Copilot",
      status: "error",
      rows: [],
      error: `Sign-in failed: ${active.resolveError}`,
    };
  }

  const token = active.accessToken ?? active.refreshToken;
  if (!token) return undefined;

  const enterprise = validateEnterpriseHost(active.fields.enterpriseUrl);
  if (enterprise.error) {
    return {
      id: "copilot",
      name: "GitHub Copilot",
      status: "error",
      rows: [],
      error: enterprise.error,
    };
  }

  const apiBase = enterprise.host ? `https://api.${enterprise.host}` : "https://api.github.com";
  const reply = await requestJson(`${apiBase}/copilot_internal/user`, {
    headers: {
      Accept: "application/json",
      Authorization: `token ${token}`,
      "Editor-Version": "vscode/1.96.2",
      "Editor-Plugin-Version": "copilot-chat/0.26.7",
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "X-GitHub-Api-Version": "2025-04-01",
    },
    secrets: [token],
    fetchImpl,
  });

  if (!reply.ok) {
    return {
      id: "copilot",
      name: "GitHub Copilot",
      status: "error",
      rows: [],
      error: reply.kind === "http" ? `HTTP ${reply.status}: ${reply.detail}` : reply.detail,
    };
  }

  const parsed = parseCopilotUserResponse(reply.json);
  if ("error" in parsed) {
    return { id: "copilot", name: "GitHub Copilot", status: "error", rows: [], error: parsed.error };
  }

  return {
    id: "copilot",
    name: "GitHub Copilot",
    account: parsed.plan,
    status: "ok",
    rows: parsed.rows,
  };
}
