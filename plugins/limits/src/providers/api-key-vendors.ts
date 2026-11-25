import { readApiKeys } from "../auth.js";
import { clampPercent, finiteNumber, isRecord, nonEmptyString, requestJson, toIsoTimestamp } from "../http.js";
import type { LimitRow, ProviderLimits } from "../types.js";
import type { ProviderContext, QuotaProvider } from "./types.js";

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/* ── Kimi Code (Global & CN) ─────────────────────────────────────────────── */

function parseKimiWindow(data: Record<string, unknown>, fallbackLabel: string): LimitRow | undefined {
  const limit = num(data.limit);
  let used = num(data.used);
  if (used === undefined) {
    const remaining = num(data.remaining);
    if (remaining !== undefined && limit !== undefined) used = limit - remaining;
  }
  if (used === undefined && limit === undefined) return undefined;
  const safeLimit = limit ?? 0;
  const safeUsed = used ?? 0;
  const percentUsed = safeLimit > 0 ? clampPercent((safeUsed / safeLimit) * 100) : 100;

  let resetsAt =
    toIsoTimestamp(data.reset_at ?? data.resetAt ?? data.reset_time ?? data.resetTime);
  if (!resetsAt) {
    const ttl = num(data.reset_in ?? data.resetIn ?? data.ttl);
    if (ttl !== undefined && ttl > 0) {
      resetsAt = new Date(Date.now() + Math.round(ttl * 1000)).toISOString();
    }
  }
  return {
    label: nonEmptyString(data.name ?? data.title) ?? fallbackLabel,
    percentUsed,
    resetsAt,
  };
}

export function parseKimiUsageResponse(json: unknown): { readonly rows: LimitRow[] } | { readonly error: string } {
  if (!isRecord(json)) return { error: "Unexpected Kimi response" };
  const data = isRecord(json.data) ? json.data : json;
  const rows: LimitRow[] = [];

  if (isRecord(data.usage)) {
    const row = parseKimiWindow(data.usage, "Weekly");
    if (row) rows.push(row);
  }
  if (Array.isArray(data.limits)) {
    data.limits.forEach((item, index) => {
      if (!isRecord(item)) return;
      const detail = isRecord(item.detail) ? item.detail : item;
      const label =
        nonEmptyString(item.name ?? item.title ?? detail.name ?? detail.title) ??
        `Limit #${index + 1}`;
      const row = parseKimiWindow(detail, label);
      if (row) rows.push(row);
    });
  }

  return rows.length > 0 ? { rows } : { error: "Kimi response contained no quota windows" };
}

/* ── Z.ai / Zhipu GLM Coding Plan ────────────────────────────────────────── */

export function parseGlmQuotaResponse(json: unknown, envelope: "zai" | "zhipu"): { readonly rows: LimitRow[] } | { readonly error: string } {
  if (!isRecord(json)) return { error: "Unexpected GLM quota response" };
  if (envelope === "zai" && (json.success === false || (typeof json.code === "number" && json.code >= 400))) {
    return { error: nonEmptyString(json.msg) ?? `GLM API error ${json.code ?? ""}`.trim() };
  }
  const data = isRecord(json.data) ? json.data : undefined;
  const limits = envelope === "zai" ? (data?.limits ?? json.limits) : data?.limits;
  if (!Array.isArray(limits)) return { error: "Invalid GLM quota data" };

  const rows: LimitRow[] = [];
  for (const item of limits) {
    if (!isRecord(item)) continue;
    const pct = finiteNumber(item.percentage);
    if (pct === undefined) continue;
    let percentUsed = clampPercent(pct);
    if (
      item.type === "CREDIT_LIMIT" &&
      typeof item.usage === "number" &&
      item.usage > 0 &&
      typeof item.currentValue === "number" &&
      item.currentValue >= 0
    ) {
      percentUsed = clampPercent((item.currentValue / item.usage) * 100);
    }

    const resetMs = finiteNumber(item.nextResetTime);
    const resetsAt = resetMs && resetMs > 0 ? new Date(Math.round(resetMs)).toISOString() : undefined;
    const isQuota = item.type === "TOKENS_LIMIT" || item.type === "CREDIT_LIMIT";
    const label =
      isQuota && item.unit === 3
        ? "5h Rolling"
        : isQuota && item.unit === 6
          ? "Weekly"
          : item.type === "TIME_LIMIT"
            ? "MCP"
            : undefined;
    if (label) rows.push({ label, percentUsed, resetsAt });
  }
  return rows.length > 0 ? { rows } : { error: "GLM response contained no quota windows" };
}

/* ── MiniMax Token Plan ──────────────────────────────────────────────────── */

export function parseMiniMaxResponse(
  json: unknown,
  endpoint: "international" | "china",
  nowMs = Date.now(),
): { readonly rows: LimitRow[] } | { readonly error: string } {
  if (!isRecord(json)) return { error: "Unexpected MiniMax response" };
  const baseResp = isRecord(json.base_resp) ? json.base_resp : undefined;
  if (baseResp?.status_code !== 0) {
    return { error: `MiniMax API error: ${nonEmptyString(baseResp?.status_msg) ?? "unknown"}` };
  }
  const models = Array.isArray(json.model_remains) ? json.model_remains.filter(isRecord) : [];
  const coding = models.filter((m) => {
    const name = nonEmptyString(m.model_name)?.toLowerCase() ?? "";
    return name.startsWith("minimax-m") || name === "general";
  });
  const chosen =
    coding.find((m) => nonEmptyString(m.model_name)?.toLowerCase() === "minimax-m*") ?? coding[0];
  if (!chosen) return { error: "No MiniMax coding model quota reported" };

  const specs = [
    {
      label: "5h Rolling",
      total: finiteNumber(chosen.current_interval_total_count),
      count: finiteNumber(chosen.current_interval_usage_count),
      offsetMs: finiteNumber(chosen.remains_time),
      remPct: finiteNumber(chosen.current_interval_remaining_percent),
    },
    {
      label: "Weekly",
      total: finiteNumber(chosen.current_weekly_total_count),
      count: finiteNumber(chosen.current_weekly_usage_count),
      offsetMs: finiteNumber(chosen.weekly_remains_time),
      remPct: finiteNumber(chosen.current_weekly_remaining_percent),
    },
  ];

  const rows: LimitRow[] = [];
  for (const s of specs) {
    if (s.offsetMs === undefined) continue;
    const resetsAt = new Date(nowMs + Math.max(0, s.offsetMs)).toISOString();
    if (s.total !== undefined && s.total > 0 && s.count !== undefined) {
      const used = endpoint === "china" ? Math.max(0, s.count) : Math.max(0, s.total - Math.min(s.total, s.count));
      rows.push({
        label: s.label,
        percentUsed: clampPercent((used / s.total) * 100),
        valueText: `${used}/${s.total} req`,
        resetsAt,
      });
    } else if (s.remPct !== undefined) {
      rows.push({
        label: s.label,
        percentUsed: clampPercent(100 - s.remPct),
        resetsAt,
      });
    }
  }
  return rows.length > 0 ? { rows } : { error: "MiniMax response contained no quota windows" };
}

/* ── Ollama Cloud ────────────────────────────────────────────────────────── */

export function parseOllamaCloudResponse(json: unknown): { readonly rows: LimitRow[] } | { readonly error: string } {
  if (!isRecord(json)) return { error: "Unexpected Ollama Cloud response" };
  const included = isRecord(json.included) ? json.included : undefined;
  const rows: LimitRow[] = [];

  if (included) {
    const balanceUsd = finiteNumber(included.balance_usd);
    const allowanceUsd = finiteNumber(included.allowance_usd);
    if (balanceUsd !== undefined && allowanceUsd !== undefined && allowanceUsd > 0) {
      const usedUsd = Math.max(0, allowanceUsd - Math.max(0, balanceUsd));
      const period = isRecord(included.period) ? included.period : undefined;
      rows.push({
        label: "Monthly",
        percentUsed: clampPercent((usedUsd / allowanceUsd) * 100),
        valueText: `$${usedUsd.toFixed(2)} / $${allowanceUsd.toFixed(2)}`,
        resetsAt: toIsoTimestamp(period?.until),
      });
    }
    for (const [key, label] of [["session", "Session"], ["weekly", "Weekly"]] as const) {
      const win = included[key];
      if (isRecord(win)) {
        const rem = finiteNumber(win.remaining_percent);
        if (rem !== undefined) {
          rows.push({
            label,
            percentUsed: clampPercent(100 - rem),
            resetsAt: toIsoTimestamp(win.resets_at),
          });
        }
      }
    }
  }

  if (isRecord(json.purchased)) {
    const purchasedUsd = finiteNumber(json.purchased.balance_usd);
    if (purchasedUsd !== undefined) {
      rows.push({ label: "Purchased", valueText: `$${purchasedUsd.toFixed(2)}` });
    }
  }

  return rows.length > 0 ? { rows } : { error: "Ollama Cloud returned no quota or balance" };
}

/* ── OpenRouter ──────────────────────────────────────────────────────────── */

export function parseOpenRouterResponse(json: unknown): { readonly rows: LimitRow[] } | { readonly error: string } {
  if (!isRecord(json) || !isRecord(json.data)) return { error: "Unexpected OpenRouter response" };
  const { usage, usage_monthly: usageMonthly, limit, limit_remaining: remaining } = json.data;
  const usedNum = finiteNumber(usage);
  const limitNum = finiteNumber(limit);
  const remNum = finiteNumber(remaining);

  if (limitNum !== undefined && limitNum > 0) {
    const remUsd = remNum ?? (usedNum !== undefined ? limitNum - usedNum : undefined);
    if (remUsd !== undefined) {
      const usedUsd = Math.max(0, limitNum - remUsd);
      return {
        rows: [
          {
            label: "Budget",
            percentUsed: clampPercent((usedUsd / limitNum) * 100),
            valueText: `$${usedUsd.toFixed(2)} / $${limitNum.toFixed(2)}`,
          },
        ],
      };
    }
  }

  const monthlyNum = finiteNumber(usageMonthly);
  if (monthlyNum !== undefined) {
    return { rows: [{ label: "This month", valueText: `$${monthlyNum.toFixed(2)}` }] };
  }
  if (usedNum !== undefined) {
    return { rows: [{ label: "Spend", valueText: `$${usedNum.toFixed(2)}` }] };
  }
  return { error: "OpenRouter response missing usage data" };
}

/* ── DeepSeek ────────────────────────────────────────────────────────────── */

export function parseDeepSeekResponse(json: unknown): { readonly rows: LimitRow[] } | { readonly error: string } {
  if (!isRecord(json)) return { error: "Unexpected DeepSeek response" };
  const infos = Array.isArray(json.balance_infos) ? json.balance_infos.filter(isRecord) : [];
  const rows: LimitRow[] = [];

  for (const info of infos) {
    const currency = nonEmptyString(info.currency)?.toUpperCase();
    const total = nonEmptyString(info.total_balance);
    if (currency && total) {
      rows.push({
        label: `Balance (${currency})`,
        valueText: `${total} ${currency}`,
      });
    }
  }

  if (rows.length === 0 && typeof json.is_available === "boolean") {
    rows.push({ label: "Available", valueText: json.is_available ? "yes" : "no" });
  }
  return rows.length > 0 ? { rows } : { error: "DeepSeek response contained no balance data" };
}

/* ── Unified Table-Driven Vendor Registry ────────────────────────────────── */

interface ApiKeyVendorSpec {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly envVars: readonly string[];
  readonly integrationIds: readonly string[];
  readonly authHeader?: (key: string) => string;
  readonly parse: (json: unknown) => { readonly rows: LimitRow[] } | { readonly error: string };
}

const API_KEY_VENDOR_SPECS: readonly ApiKeyVendorSpec[] = [
  {
    id: "kimi-code",
    name: "Kimi Code",
    url: "https://api.kimi.ai/coding/v1/usages",
    envVars: ["KIMI_GLOBAL_API_KEY"],
    integrationIds: ["kimi-code-plan-global"],
    parse: parseKimiUsageResponse,
  },
  {
    id: "kimi-code-cn",
    name: "Kimi Code (CN)",
    url: "https://api.kimi.com/coding/v1/usages",
    envVars: ["KIMI_CN_API_KEY", "KIMI_API_KEY", "KIMI_CODE_API_KEY"],
    integrationIds: ["kimi-code-plan-cn", "kimi-for-coding", "kimi-code", "kimi"],
    parse: parseKimiUsageResponse,
  },
  {
    id: "zai",
    name: "Z.ai",
    url: "https://api.z.ai/api/monitor/usage/quota/limit",
    envVars: ["ZAI_API_KEY", "ZAI_CODING_PLAN_API_KEY"],
    integrationIds: ["zai", "zai-coding-plan", "glm"],
    authHeader: (key) => key,
    parse: (json) => parseGlmQuotaResponse(json, "zai"),
  },
  {
    id: "zhipu",
    name: "Zhipu",
    url: "https://bigmodel.cn/api/monitor/usage/quota/limit",
    envVars: ["ZHIPU_API_KEY", "ZHIPU_CODING_PLAN_API_KEY"],
    integrationIds: ["zhipu", "zhipu-coding-plan", "zhipuai-coding-plan", "glm-coding-plan"],
    authHeader: (key) => key,
    parse: (json) => parseGlmQuotaResponse(json, "zhipu"),
  },
  {
    id: "minimax",
    name: "MiniMax",
    url: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
    envVars: ["MINIMAX_CODING_PLAN_API_KEY", "MINIMAX_API_KEY"],
    integrationIds: ["minimax-coding-plan", "minimax"],
    parse: (json) => parseMiniMaxResponse(json, "international"),
  },
  {
    id: "minimax-cn",
    name: "MiniMax (CN)",
    url: "https://api.minimaxi.com/v1/token_plan/remains",
    envVars: ["MINIMAX_CHINA_CODING_PLAN_API_KEY"],
    integrationIds: ["minimax-china-coding-plan", "minimax-cn-coding-plan", "minimax-cn", "minimax-china"],
    parse: (json) => parseMiniMaxResponse(json, "china"),
  },
  {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    url: "https://ollama.com/api/balance",
    envVars: ["OLLAMA_API_KEY"],
    integrationIds: ["ollama-cloud"],
    parse: parseOllamaCloudResponse,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1/key",
    envVars: ["OPENROUTER_API_KEY"],
    integrationIds: ["openrouter"],
    parse: parseOpenRouterResponse,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    url: "https://api.deepseek.com/user/balance",
    envVars: ["DEEPSEEK_API_KEY"],
    integrationIds: ["deepseek"],
    parse: parseDeepSeekResponse,
  },
];

async function fetchApiKeyVendor(spec: ApiKeyVendorSpec, pctx: ProviderContext): Promise<ProviderLimits | undefined> {
  const keys = await readApiKeys(pctx.ctx, {
    envVars: spec.envVars,
    integrationIds: spec.integrationIds,
  });
  if (keys.length === 0) return undefined;

  const target = keys[0];
  const authValue = spec.authHeader ? spec.authHeader(target.key) : `Bearer ${target.key}`;
  const reply = await requestJson(spec.url, {
    headers: {
      Authorization: authValue,
      Accept: "application/json",
      "User-Agent": "OpenCode-Limits/0.1",
    },
    secrets: [target.key],
    fetchImpl: pctx.fetchImpl,
  });

  if (!reply.ok) {
    return {
      id: spec.id,
      name: spec.name,
      account: target.label,
      status: "error",
      rows: [],
      error: reply.kind === "http" ? `HTTP ${reply.status}: ${reply.detail}` : reply.detail,
    };
  }

  const parsed = spec.parse(reply.json);
  if ("error" in parsed) {
    return { id: spec.id, name: spec.name, account: target.label, status: "error", rows: [], error: parsed.error };
  }

  return {
    id: spec.id,
    name: spec.name,
    account: target.label,
    status: "ok",
    rows: parsed.rows,
  };
}

export const API_KEY_PROVIDERS: readonly QuotaProvider[] = API_KEY_VENDOR_SPECS.map((spec) => ({
  id: spec.id,
  name: spec.name,
  fetch: (pctx) => fetchApiKeyVendor(spec, pctx),
}));
