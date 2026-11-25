export interface LimitRow {
  readonly label: string;
  /** Percentage of the quota window already used (0..100). */
  readonly percentUsed?: number;
  /** ISO-8601 UTC timestamp when this window resets. */
  readonly resetsAt?: string;
  /** Optional formatted scalar value (e.g. "$14.20", "120/300 req"). */
  readonly valueText?: string;
}

export type ProviderStatus = "ok" | "error";

export interface ProviderLimits {
  readonly id: string;
  readonly name: string;
  readonly account?: string;
  readonly status: ProviderStatus;
  readonly rows: readonly LimitRow[];
  readonly error?: string;
  readonly cached?: boolean;
}

export interface LimitsSnapshot {
  readonly fetchedAtMs: number;
  readonly providers: readonly ProviderLimits[];
}

export interface LimitsPluginOptions {
  /** Optional allowlist of provider ids (defaults to all auto-detected providers). */
  readonly include?: readonly string[];
  /** Optional denylist of provider ids to omit from display. */
  readonly exclude?: readonly string[];
}
