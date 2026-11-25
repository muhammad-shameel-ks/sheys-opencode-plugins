import type { ProviderLimits } from "./types.js";

export const DEFAULT_TTL_MS = 60_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

interface CacheEntry {
  readonly result: ProviderLimits;
  readonly fetchedAtMs: number;
}

interface CooldownEntry {
  readonly blockedUntilMs: number;
  readonly failureCount: number;
}

export function parseRetryAfterMs(headerValue: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  }
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : undefined;
}

export class ProviderLimitsCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly cooldowns = new Map<string, CooldownEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get(id: string, name: string, nowMs: number, force = false): ProviderLimits | undefined {
    const cooldown = this.cooldowns.get(id);
    const cached = this.entries.get(id);

    if (cooldown && cooldown.blockedUntilMs > nowMs) {
      if (cached && cached.result.status === "ok") {
        return { ...cached.result, cached: true };
      }
      const seconds = Math.ceil((cooldown.blockedUntilMs - nowMs) / 1000);
      return {
        id,
        name,
        status: "error",
        rows: [],
        error: `Rate limited; retry in ${seconds}s`,
      };
    }

    if (!force && cached && nowMs >= cached.fetchedAtMs && nowMs - cached.fetchedAtMs < this.ttlMs) {
      return { ...cached.result, cached: true };
    }

    return undefined;
  }

  recordSuccess(id: string, result: ProviderLimits, nowMs = Date.now()): void {
    this.cooldowns.delete(id);
    this.entries.set(id, { result: { ...result, cached: false }, fetchedAtMs: nowMs });
  }

  recordRateLimit(id: string, retryAfterHeader: string | null | undefined, nowMs = Date.now()): number {
    const previous = this.cooldowns.get(id)?.failureCount ?? 0;
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader, nowMs) ?? 0;
    const durationMs = Math.min(MAX_BACKOFF_MS, Math.max(BASE_BACKOFF_MS * 2 ** previous, retryAfterMs));
    this.cooldowns.set(id, {
      failureCount: previous + 1,
      blockedUntilMs: nowMs + durationMs,
    });
    return durationMs;
  }

  clearCooldown(id: string): void {
    this.cooldowns.delete(id);
  }

  invalidate(): void {
    this.entries.clear();
    this.cooldowns.clear();
  }
}
