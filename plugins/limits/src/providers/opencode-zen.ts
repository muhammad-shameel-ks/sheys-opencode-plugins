import { readIntegrationConnections } from "../auth.js";
import { clampPercent, finiteNumber, isRecord, nonEmptyString, requestJson } from "../http.js";
import type { LimitRow, ProviderLimits } from "../types.js";
import type { ProviderContext } from "./types.js";

const DEFAULT_CONSOLE_URL = "https://opencode.ai/console";
const BILLING_UNITS_PER_USD = 100_000_000;

function parseMicroCents(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function fmtUsd(amount: number): string {
  const fixed = amount.toFixed(2);
  return `$${fixed}`;
}

export function parseZenConsoleResponses(input: {
  readonly statusJson: unknown;
  readonly accountJson?: unknown;
  readonly costByDayJson?: unknown;
  readonly now?: Date;
}): { readonly rows: LimitRow[] } | { readonly error: string } {
  const balanceRaw = isRecord(input.statusJson) ? parseMicroCents(input.statusJson.balanceMicroCents) : undefined;
  if (balanceRaw === undefined) {
    return { error: "Unexpected OpenCode Zen balance response" };
  }
  const balanceUsd = Math.max(0, balanceRaw) / BILLING_UNITS_PER_USD;

  let monthlyLimitUsd: number | undefined;
  if (isRecord(input.accountJson)) {
    const limitRaw = parseMicroCents(input.accountJson.creditLimitMicroCents);
    if (limitRaw !== undefined && limitRaw > 0) {
      monthlyLimitUsd = limitRaw / BILLING_UNITS_PER_USD;
    }
  }

  let monthlyUsageUsd: number | undefined;
  if (Array.isArray(input.costByDayJson)) {
    const now = input.now ?? new Date();
    const monthPrefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    let sumMicroCents = 0;
    let valid = true;
    for (const entry of input.costByDayJson) {
      if (!isRecord(entry) || typeof entry.date !== "string") {
        valid = false;
        break;
      }
      const cost = parseMicroCents(entry.totalCostMicroCents);
      if (cost === undefined) {
        valid = false;
        break;
      }
      if (entry.date.slice(0, 7) === monthPrefix) {
        sumMicroCents += cost;
      }
    }
    if (valid) monthlyUsageUsd = Math.max(0, sumMicroCents) / BILLING_UNITS_PER_USD;
  }

  const rows: LimitRow[] = [];
  if (monthlyLimitUsd !== undefined && monthlyUsageUsd !== undefined) {
    rows.push({
      label: "Monthly",
      percentUsed: clampPercent((monthlyUsageUsd / monthlyLimitUsd) * 100),
      valueText: `${fmtUsd(monthlyUsageUsd)} / ${fmtUsd(monthlyLimitUsd)}`,
    });
  } else if (monthlyUsageUsd !== undefined && finiteNumber(monthlyUsageUsd) !== undefined) {
    rows.push({
      label: "This month",
      valueText: fmtUsd(monthlyUsageUsd),
    });
  }

  rows.push({
    label: "Balance",
    valueText: fmtUsd(balanceUsd),
  });

  return { rows };
}

export async function fetchOpenCodeZen(pctx: ProviderContext): Promise<ProviderLimits | undefined> {
  const { ctx, fetchImpl } = pctx;
  const conns = await readIntegrationConnections(ctx, ["opencode"], ["oauth"]);
  const active = conns.find((c) => c.active) ?? conns[0];
  if (!active || active.resolveError || !active.accessToken) return undefined;

  const baseUrl = (active.server ?? DEFAULT_CONSOLE_URL).replace(/\/+$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${active.accessToken}`,
    Accept: "application/json",
  };
  if (active.orgId) headers["x-org-id"] = active.orgId;
  const secrets = [active.accessToken];

  const [statusReply, accountReply, usageReply] = await Promise.all([
    requestJson(`${baseUrl}/api/billing/status`, { headers, secrets, fetchImpl }),
    requestJson(`${baseUrl}/api/billing/account`, { headers, secrets, fetchImpl }),
    requestJson(`${baseUrl}/api/usage/cost-by-day`, { headers, secrets, fetchImpl }),
  ]);

  if (!statusReply.ok) {
    if (statusReply.kind === "http" && (statusReply.status === 401 || statusReply.status === 404)) {
      return undefined;
    }
    return {
      id: "opencode-zen",
      name: "OpenCode Zen",
      status: "error",
      rows: [],
      error: statusReply.kind === "http" ? `HTTP ${statusReply.status}: ${statusReply.detail}` : statusReply.detail,
    };
  }

  const parsed = parseZenConsoleResponses({
    statusJson: statusReply.json,
    accountJson: accountReply.ok ? accountReply.json : undefined,
    costByDayJson: usageReply.ok ? usageReply.json : undefined,
  });

  if ("error" in parsed) {
    return { id: "opencode-zen", name: "OpenCode Zen", status: "error", rows: [], error: parsed.error };
  }

  return {
    id: "opencode-zen",
    name: "OpenCode Zen",
    account: nonEmptyString(active.fields.orgName) ?? nonEmptyString(active.fields.email),
    status: "ok",
    rows: parsed.rows,
  };
}
