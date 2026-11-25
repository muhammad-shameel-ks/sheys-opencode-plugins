import { readClaudeCliOAuthToken, readIntegrationConnections } from "../auth.js";
import { clampPercent, finiteNumber, isRecord, requestJson, toIsoTimestamp } from "../http.js";
import type { LimitRow, ProviderLimits } from "../types.js";
import type { ProviderContext } from "./types.js";

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_BETA_HEADER = "oauth-2025-04-20";
const USER_AGENT = "claude-code/2.1.0";

function readUtilizationPercent(windowObj: unknown): number | undefined {
  if (!isRecord(windowObj)) return undefined;
  for (const key of ["utilization", "used_percentage", "usedPercentage", "used_percent", "usedPercent"]) {
    const raw = windowObj[key];
    const num = typeof raw === "string" && raw.trim() ? Number(raw.trim()) : finiteNumber(raw);
    if (num !== undefined && Number.isFinite(num)) return clampPercent(num);
  }
  return undefined;
}

function parseWindowRow(label: string, value: unknown): LimitRow | undefined {
  if (!isRecord(value)) return undefined;
  const percentUsed = readUtilizationPercent(value);
  if (percentUsed === undefined) return undefined;
  const resetsAt = toIsoTimestamp(value.resets_at ?? value.resetsAt ?? value.reset_at ?? value.resetAt);
  return { label, percentUsed, resetsAt };
}

export function parseAnthropicUsageResponse(json: unknown): { readonly rows: LimitRow[] } | { readonly error: string } {
  if (!isRecord(json)) return { error: "Unexpected Anthropic usage response" };

  const candidates = [json, ...["usage", "quota", "rate_limits"].map((k) => json[k]).filter(isRecord)];
  const rows: LimitRow[] = [];

  for (const root of candidates) {
    const fiveHour = parseWindowRow("5h Session", root.five_hour ?? root.fiveHour);
    const sevenDay = parseWindowRow("7d All", root.seven_day ?? root.sevenDay);
    const sevenDaySonnet = parseWindowRow("7d Sonnet", root.seven_day_sonnet ?? root.sevenDaySonnet);
    const sevenDayOpus = parseWindowRow("7d Opus", root.seven_day_opus ?? root.sevenDayOpus);

    if (fiveHour || sevenDay) {
      if (fiveHour) rows.push(fiveHour);
      if (sevenDay) rows.push(sevenDay);
      if (sevenDaySonnet) rows.push(sevenDaySonnet);
      if (sevenDayOpus) rows.push(sevenDayOpus);

      if (isRecord(root.extra_usage) && root.extra_usage.is_enabled === true) {
        const extra = root.extra_usage;
        const util = finiteNumber(extra.utilization);
        const used = finiteNumber(extra.used_credits);
        const limit = finiteNumber(extra.monthly_limit);
        const percentUsed =
          util !== undefined
            ? clampPercent(util)
            : used !== undefined && limit !== undefined && limit > 0
              ? clampPercent((used / limit) * 100)
              : undefined;
        if (percentUsed !== undefined) {
          const valueText =
            used !== undefined && limit !== undefined
              ? `$${(used / 100).toFixed(2)} / $${(limit / 100).toFixed(2)}`
              : undefined;
          rows.push({ label: "Extra usage", percentUsed, valueText });
        }
      }
      break;
    }
  }

  if (rows.length === 0) {
    return { error: "Anthropic response contained no quota windows" };
  }
  return { rows };
}

export async function fetchAnthropic(pctx: ProviderContext): Promise<ProviderLimits | undefined> {
  const { ctx, cache, fetchImpl } = pctx;

  const connections = await readIntegrationConnections(ctx, ["anthropic"], ["oauth"]);
  const tokens: Array<{ readonly token: string; readonly label?: string }> = [];
  const seen = new Set<string>();
  let resolveError: string | undefined;

  for (const conn of connections) {
    if (conn.resolveError) {
      resolveError ??= conn.resolveError;
      continue;
    }
    if (conn.fields.commonAuthPlaceholder === true || !conn.accessToken) continue;
    if (conn.expiresAt !== undefined && conn.expiresAt <= Date.now()) {
      resolveError ??= "Anthropic OAuth token expired (run `opencode auth login anthropic`)";
      continue;
    }
    if (!seen.has(conn.accessToken)) {
      seen.add(conn.accessToken);
      const label = conn.label && !["default", "oauth"].includes(conn.label.toLowerCase()) ? conn.label : undefined;
      tokens.push({ token: conn.accessToken, label });
    }
  }

  // Fallback / supplement: Claude Code / Claude Agent OAuth in Keychain or ~/.claude/.credentials.json
  if (tokens.length === 0) {
    const cliToken = await readClaudeCliOAuthToken();
    if (cliToken && !seen.has(cliToken)) {
      seen.add(cliToken);
      tokens.push({ token: cliToken, label: "Claude Code" });
    }
  }

  if (tokens.length === 0) {
    if (!resolveError) return undefined;
    return {
      id: "anthropic",
      name: "Claude",
      status: "error",
      rows: [],
      error: resolveError,
    };
  }

  const target = tokens[0];
  const reply = await requestJson(ANTHROPIC_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${target.token}`,
      "anthropic-beta": ANTHROPIC_BETA_HEADER,
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    secrets: [target.token],
    fetchImpl,
  });

  if (!reply.ok) {
    if (reply.kind === "http" && reply.status === 429) {
      const waitMs = cache.recordRateLimit("anthropic", reply.headers?.get("Retry-After"));
      const cached = cache.get("anthropic", "Claude", Date.now(), false);
      if (cached && cached.status === "ok") return cached;
      return {
        id: "anthropic",
        name: "Claude",
        account: target.label,
        status: "error",
        rows: [],
        error: `Rate limited (429); retry in ${Math.ceil(waitMs / 1000)}s`,
      };
    }
    return {
      id: "anthropic",
      name: "Claude",
      account: target.label,
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

  const parsed = parseAnthropicUsageResponse(reply.json);
  if ("error" in parsed) {
    return { id: "anthropic", name: "Claude", account: target.label, status: "error", rows: [], error: parsed.error };
  }

  return {
    id: "anthropic",
    name: "Claude",
    account: target.label,
    status: "ok",
    rows: parsed.rows,
  };
}
