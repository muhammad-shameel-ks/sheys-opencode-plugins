import { readIntegrationConnections } from "../auth.js";
import { clampPercent, finiteNumber, isRecord, nonEmptyString, requestJson } from "../http.js";
import type { LimitRow, ProviderLimits } from "../types.js";
import type { ProviderContext } from "./types.js";

const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const WINDOW_BY_DURATION: Record<number, string> = {
  18000: "5h Rolling",
  604800: "Weekly",
  2628000: "Monthly",
};

function parseJwtAccountId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!isRecord(payload)) return undefined;
    const authClaim = payload["https://api.openai.com/auth"];
    return isRecord(authClaim) ? nonEmptyString(authClaim.chatgpt_account_id) : undefined;
  } catch {
    return undefined;
  }
}

function windowResetIso(window: Record<string, unknown>, nowMs: number): string | undefined {
  const resetAt = finiteNumber(window.reset_at);
  if (resetAt !== undefined && resetAt > 0) {
    return new Date(Math.round(resetAt * 1000)).toISOString();
  }
  const resetAfter = finiteNumber(window.reset_after_seconds);
  if (resetAfter !== undefined && resetAfter > 0) {
    return new Date(nowMs + Math.round(resetAfter * 1000)).toISOString();
  }
  return undefined;
}

function formatPlanLabel(planType: unknown): string | undefined {
  const raw = nonEmptyString(planType);
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (lower === "team" || lower === "business") return "Business";
  if (lower.includes("pro")) return "Pro";
  if (lower.includes("plus")) return "Plus";
  return raw;
}

export function parseOpenAIUsageResponse(
  json: unknown,
  nowMs = Date.now(),
): { readonly rows: LimitRow[]; readonly plan?: string } | { readonly error: string } {
  if (!isRecord(json)) return { error: "Unexpected OpenAI usage response" };

  const rows: LimitRow[] = [];
  const rateLimit = isRecord(json.rate_limit) ? json.rate_limit : undefined;

  for (const win of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
    if (!isRecord(win)) continue;
    const duration = finiteNumber(win.limit_window_seconds);
    const usedPercent = finiteNumber(win.used_percent);
    const label = duration !== undefined ? WINDOW_BY_DURATION[duration] : undefined;
    if (!label || usedPercent === undefined) continue;
    rows.push({
      label,
      percentUsed: clampPercent(usedPercent),
      resetsAt: windowResetIso(win, nowMs),
    });
  }

  if (isRecord(json.spend_control) && isRecord(json.spend_control.individual_limit)) {
    const remainingPct = finiteNumber(json.spend_control.individual_limit.remaining_percent);
    if (remainingPct !== undefined && !rows.some((r) => r.label === "Monthly")) {
      rows.push({
        label: "Monthly",
        percentUsed: clampPercent(100 - remainingPct),
        resetsAt: windowResetIso(json.spend_control.individual_limit, nowMs),
      });
    }
  }

  if (isRecord(json.code_review_rate_limit) && isRecord(json.code_review_rate_limit.primary_window)) {
    const crWin = json.code_review_rate_limit.primary_window;
    const usedPct = finiteNumber(crWin.used_percent);
    if (usedPct !== undefined) {
      rows.push({
        label: "Code Review",
        percentUsed: clampPercent(usedPct),
        resetsAt: windowResetIso(crWin, nowMs),
      });
    }
  }

  if (rows.length === 0) {
    return { error: "OpenAI response contained no quota windows" };
  }

  return { rows, plan: formatPlanLabel(json.plan_type) };
}

export async function fetchOpenAI(pctx: ProviderContext): Promise<ProviderLimits | undefined> {
  const { ctx, fetchImpl } = pctx;
  const conns = await readIntegrationConnections(ctx, ["openai", "codex", "chatgpt"], ["oauth"]);
  const usable = conns.filter((c) => c.methodID !== "chatgpt-token-sharing");
  const target = usable.find((c) => c.active) ?? usable[0];

  if (!target) return undefined;

  if (target.resolveError) {
    return {
      id: "openai",
      name: "OpenAI / Codex",
      status: "error",
      rows: [],
      error: `Sign-in failed: ${target.resolveError}`,
    };
  }

  if (!target.accessToken) return undefined;
  if (target.expiresAt !== undefined && target.expiresAt < Date.now()) {
    return {
      id: "openai",
      name: "OpenAI / Codex",
      status: "error",
      rows: [],
      error: "OAuth token expired (run `opencode auth login openai`)",
    };
  }

  const accountId = target.accountId ?? parseJwtAccountId(target.accessToken);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${target.accessToken}`,
    "User-Agent": "OpenCode-Limits/0.1",
    Accept: "application/json",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  const reply = await requestJson(OPENAI_USAGE_URL, {
    headers,
    secrets: [target.accessToken, accountId],
    fetchImpl,
  });

  if (!reply.ok) {
    return {
      id: "openai",
      name: "OpenAI / Codex",
      status: "error",
      rows: [],
      error: reply.kind === "http" ? `HTTP ${reply.status}: ${reply.detail}` : reply.detail,
    };
  }

  const parsed = parseOpenAIUsageResponse(reply.json);
  if ("error" in parsed) {
    return { id: "openai", name: "OpenAI / Codex", status: "error", rows: [], error: parsed.error };
  }

  return {
    id: "openai",
    name: "OpenAI / Codex",
    account: parsed.plan,
    status: "ok",
    rows: parsed.rows,
  };
}
