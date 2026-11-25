import { clampPercent } from "./http.js";
import type { LimitRow, LimitsSnapshot, ProviderLimits } from "./types.js";

export function formatPercent(percentUsed: number): string {
  const clamped = clampPercent(percentUsed);
  const rounded = Math.round(clamped * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

export function renderBar(percentUsed: number, width = 18): string {
  const clamped = clampPercent(percentUsed);
  const filled = Math.min(width, Math.max(0, Math.round((clamped / 100) * width)));
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

export function formatResetCountdown(resetsAtIso: string | undefined, nowMs = Date.now()): string {
  if (!resetsAtIso) return "";
  const resetMs = Date.parse(resetsAtIso);
  if (!Number.isFinite(resetMs)) return "";

  const diffMs = resetMs - nowMs;
  if (diffMs <= 0) return "resetting";

  const totalMinutes = Math.floor(diffMs / 60_000);
  if (totalMinutes < 1) return "resets <1m";
  if (totalMinutes < 60) return `resets in ${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return minutes > 0 ? `resets in ${totalHours}h ${minutes}m` : `resets in ${totalHours}h`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days <= 7) {
    return hours > 0 ? `resets in ${days}d ${hours}h` : `resets in ${days}d`;
  }

  const date = new Date(resetMs);
  const month = date.toLocaleString("en-US", { month: "short" });
  return `resets ${month} ${date.getDate()}`;
}

export function formatRowLine(row: LimitRow, labelWidth: number, nowMs = Date.now()): string {
  const label = row.label.padEnd(labelWidth);
  const reset = formatResetCountdown(row.resetsAt, nowMs);

  if (row.percentUsed !== undefined) {
    const bar = renderBar(row.percentUsed);
    const pct = formatPercent(row.percentUsed).padStart(5);
    const parts = [`  ${label}  ${bar} ${pct}`];
    if (row.valueText) parts.push(row.valueText);
    if (reset) parts.push(reset);
    return parts.join("  ");
  }

  const parts = [`  ${label}  ${row.valueText ?? "-"}`];
  if (reset) parts.push(reset);
  return parts.join("  ");
}

export function formatProviderLines(provider: ProviderLimits, nowMs = Date.now()): string[] {
  const heading = provider.account ? `${provider.name} (${provider.account})` : provider.name;
  const suffix = provider.cached ? " [cached]" : "";
  const lines = [`${heading}${suffix}`];

  if (provider.status === "error") {
    lines.push(`  Error: ${provider.error ?? "Unavailable"}`);
    return lines;
  }

  if (provider.rows.length === 0) {
    lines.push("  No active quota windows");
    return lines;
  }

  const labelWidth = Math.max(10, ...provider.rows.map((row) => row.label.length));
  for (const row of provider.rows) {
    lines.push(formatRowLine(row, labelWidth, nowMs));
  }
  return lines;
}

export function formatLimitsText(snapshot: LimitsSnapshot, nowMs = Date.now()): string {
  if (snapshot.providers.length === 0) {
    return "No configured providers found.";
  }
  return snapshot.providers.map((provider) => formatProviderLines(provider, nowMs).join("\n")).join("\n\n");
}
