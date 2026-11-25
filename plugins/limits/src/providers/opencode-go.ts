import { readApiKeys, readIntegrationConnections } from "../auth.js";
import { clampPercent, finiteNumber, isRecord, nonEmptyString, requestJson, toIsoTimestamp } from "../http.js";
import type { LimitRow, ProviderLimits } from "../types.js";
import type { ProviderContext } from "./types.js";

const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const DEFAULT_CONSOLE_URL = "https://opencode.ai/console";

const GO_WINDOWS = [
  { apiKey: "rolling", consoleKey: "fiveHour", label: "5h Rolling" },
  { apiKey: "weekly", consoleKey: "week", label: "Weekly" },
  { apiKey: "monthly", consoleKey: "month", label: "Monthly" },
] as const;

function asNumeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function parseGoUsageResponse(json: unknown): { readonly rows: LimitRow[] } | { readonly error: string } {
  if (!isRecord(json) || !isRecord(json.usage)) {
    return { error: "Unexpected OpenCode Go API response" };
  }
  const rows: LimitRow[] = [];
  for (const spec of GO_WINDOWS) {
    const win = json.usage[spec.apiKey];
    if (!isRecord(win)) return { error: `Missing ${spec.apiKey} window in OpenCode Go response` };
    const percent = finiteNumber(win.percent);
    if (percent === undefined) return { error: `Invalid ${spec.apiKey} percent` };
    const exhausted = win.status === "rate-limited";
    rows.push({
      label: spec.label,
      percentUsed: exhausted ? 100 : clampPercent(percent),
      resetsAt: toIsoTimestamp(win.resetsAt),
    });
  }
  return { rows };
}

export function parseGoConsoleStatus(
  json: unknown,
): { readonly subscribed: false } | { readonly subscribed: true; readonly rows: LimitRow[] } | { readonly error: string } {
  if (!isRecord(json)) return { error: "Unexpected OpenCode Console response" };
  if (!isRecord(json.access)) return { subscribed: false };
  const meters = json.access.meters;
  if (!isRecord(meters)) return { error: "Missing Go meters in Console response" };
  const fallbackReset = toIsoTimestamp(json.access.endsAt);

  const rows: LimitRow[] = [];
  for (const spec of GO_WINDOWS) {
    const meter = meters[spec.consoleKey];
    if (!isRecord(meter)) return { error: `Missing ${spec.consoleKey} meter` };
    const limit = asNumeric(meter.limitMicroCents);
    const used = asNumeric(meter.usedMicroCents);
    if (limit === undefined || used === undefined || limit < 0 || used < 0) {
      return { error: `Invalid ${spec.consoleKey} meter values` };
    }
    const percentUsed = limit === 0 ? (used > 0 ? 100 : 0) : clampPercent((used / limit) * 100);
    rows.push({
      label: spec.label,
      percentUsed,
      resetsAt: toIsoTimestamp(meter.resetsAt) ?? fallbackReset,
    });
  }
  return { subscribed: true, rows };
}

function isEntitlementError(detail: string): boolean {
  try {
    const parsed = JSON.parse(detail);
    return isRecord(parsed) && parsed.type === "error" && isRecord(parsed.error) && parsed.error.type === "EntitlementError";
  } catch {
    return false;
  }
}

export async function fetchOpenCodeGo(pctx: ProviderContext): Promise<ProviderLimits | undefined> {
  const { ctx, fetchImpl } = pctx;

  // 1. Try Console OAuth login (`opencode`) first.
  const consoleConns = await readIntegrationConnections(ctx, ["opencode"], ["oauth"]);
  const activeConsole = consoleConns.find((c) => c.active) ?? consoleConns[0];
  let consoleError: string | undefined;

  if (activeConsole) {
    if (activeConsole.resolveError) {
      consoleError = `Console sign-in failed: ${activeConsole.resolveError}`;
    } else if (activeConsole.accessToken) {
      const baseUrl = (activeConsole.server ?? DEFAULT_CONSOLE_URL).replace(/\/+$/, "");
      const headers: Record<string, string> = {
        Authorization: `Bearer ${activeConsole.accessToken}`,
        Accept: "application/json",
      };
      if (activeConsole.orgId) headers["x-org-id"] = activeConsole.orgId;

      const reply = await requestJson(`${baseUrl}/api/go/status`, {
        headers,
        secrets: [activeConsole.accessToken],
        fetchImpl,
      });

      if (reply.ok) {
        const parsed = parseGoConsoleStatus(reply.json);
        if ("error" in parsed) {
          consoleError = parsed.error;
        } else if (!parsed.subscribed) {
          return undefined;
        } else {
          return {
            id: "opencode-go",
            name: "OpenCode Go",
            account: nonEmptyString(activeConsole.fields.orgName) ?? nonEmptyString(activeConsole.fields.email),
            status: "ok",
            rows: parsed.rows,
          };
        }
      } else if (reply.kind === "http" && reply.status === 404) {
        return undefined;
      } else {
        consoleError = `Console API error${reply.status ? ` ${reply.status}` : ""}: ${reply.detail}`;
      }
    }
  }

  // 2. Fall back to OpenCode Go / Zen API key.
  const keys = await readApiKeys(ctx, {
    envVars: ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"],
    integrationIds: ["opencode-go", "opencode"],
  });

  if (keys.length === 0) {
    if (!consoleError) return undefined;
    return {
      id: "opencode-go",
      name: "OpenCode Go",
      status: "error",
      rows: [],
      error: consoleError,
    };
  }

  for (const entry of keys) {
    const reply = await requestJson(GO_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${entry.key}`,
        Accept: "application/json",
      },
      secrets: [entry.key],
      fetchImpl,
    });

    if (!reply.ok) {
      if (reply.kind === "http" && reply.status === 403 && isEntitlementError(reply.detail)) {
        continue;
      }
      return {
        id: "opencode-go",
        name: "OpenCode Go",
        account: entry.label,
        status: "error",
        rows: [],
        error: reply.kind === "http" ? `HTTP ${reply.status}: ${reply.detail}` : reply.detail,
      };
    }

    const parsed = parseGoUsageResponse(reply.json);
    if ("error" in parsed) {
      return { id: "opencode-go", name: "OpenCode Go", account: entry.label, status: "error", rows: [], error: parsed.error };
    }
    return {
      id: "opencode-go",
      name: "OpenCode Go",
      account: entry.label,
      status: "ok",
      rows: parsed.rows,
    };
  }

  return undefined;
}
